import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { hasRole, isRole } from "@/lib/meridian/access";
import { withTransaction } from "@/lib/meridian/learning/store";
import { utcDay } from "@/lib/meridian/observability/timestamps";
import { groupUsage, summarizeUsage, type UsageRun } from "@/lib/meridian/observability/usage";
import {
  countsByStatus,
  heartbeatState,
  JOB_PAGE_SIZE,
  jobDetailView,
  jobListFilters,
  jobRefInput,
  jobView,
  workerHealthView,
  workspaceInput,
} from "./ops.ts";

async function requireAdmin(userId: string, organizationId: string) {
  const sql = await getSql();
  const memberships = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = memberships[0]?.role;
  if (!role || !isRole(role) || !hasRole(role, "admin")) throw new Error("This workspace is not available to you.");
  return sql;
}

async function healthSnapshot(sql: Sql, organizationId: string) {
  const [beats, counts] = await Promise.all([
    sql<{ name: string; beat_at: unknown }>`select name, beat_at from process_heartbeats where name in ('worker', 'scheduler')`,
    sql<{ status: string; count: unknown }>`select status, count(*) as count from jobs where organization_id = ${organizationId} group by status`,
  ]);
  return { beats, counts: countsByStatus(counts) };
}

/** Jobs for one workspace, filtered by status, job type and brand, 50 per page, newest first. */
export const listJobs = createServerFn({ method: "POST" })
  .validator((input: unknown) => jobListFilters(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const [rows, totals, health] = await Promise.all([
      sql<Record<string, unknown>>`
        select j.id, j.brand_id, coalesce(b.name, '') as brand_name, j.job_type, j.status, j.attempts, j.max_attempts,
          j.last_error, j.payload, j.created_at, j.updated_at, j.run_after, j.cancel_requested
        from jobs j
        left join brands b on b.id = j.brand_id and b.organization_id = j.organization_id
        where j.organization_id = ${data.organizationId}
          and (${data.status} = '' or j.status = ${data.status})
          and (${data.type} = '' or j.job_type = ${data.type})
          and (${data.brandId} = '' or j.brand_id = ${data.brandId})
        order by j.created_at desc, j.id desc
        limit ${JOB_PAGE_SIZE} offset ${data.page * JOB_PAGE_SIZE}
      `,
      sql<{ count: unknown }>`
        select count(*) as count from jobs j
        where j.organization_id = ${data.organizationId}
          and (${data.status} = '' or j.status = ${data.status})
          and (${data.type} = '' or j.job_type = ${data.type})
          and (${data.brandId} = '' or j.brand_id = ${data.brandId})
      `,
      healthSnapshot(sql, data.organizationId),
    ]);
    const now = Date.now();
    const state = (name: string) => heartbeatState(health.beats.find((beat) => beat.name === name)?.beat_at, now).state;
    return {
      worker: state("worker"),
      scheduler: state("scheduler"),
      counts: health.counts,
      jobs: rows.map((row) => jobView(row)),
      total: Number(totals[0]?.count ?? 0),
      page: data.page,
      pageSize: JOB_PAGE_SIZE,
    };
  });

/** One job in this workspace. Payload values are never returned, only field names and types. */
export const getJobDetail = createServerFn({ method: "POST" })
  .validator((input: unknown) => jobRefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const rows = await sql<Record<string, unknown>>`
      select j.id, j.brand_id, coalesce(b.name, '') as brand_name, j.job_type, j.status, j.attempts, j.max_attempts,
        j.last_error, j.payload, j.result, j.created_at, j.updated_at, j.run_after, j.cancel_requested,
        j.lease_until, j.heartbeat_at, j.depends_on, j.priority
      from jobs j
      left join brands b on b.id = j.brand_id and b.organization_id = j.organization_id
      where j.id = ${data.jobId} and j.organization_id = ${data.organizationId}
      limit 1
    `;
    if (!rows[0]) throw new Error("That job is not available in this workspace.");
    return jobDetailView(rows[0]);
  });

/** Worker and scheduler liveness (30-second rule), queue depth and dead-letter count for one workspace. */
export const getWorkerHealth = createServerFn({ method: "POST" })
  .validator((input: unknown) => workspaceInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const health = await healthSnapshot(sql, data.organizationId);
    return workerHealthView({ beats: health.beats, counts: health.counts, now: Date.now() });
  });

async function currentJobStatus(sql: Sql, organizationId: string, jobId: string): Promise<{ status: string; cancelRequested: boolean } | null> {
  const rows = await sql<{ status: string; cancel_requested: boolean }>`
    select status, cancel_requested from jobs where id = ${jobId} and organization_id = ${organizationId} limit 1
  `;
  const row = rows[0];
  return row ? { status: row.status, cancelRequested: row.cancel_requested === true } : null;
}

/** Re-queues one dead job. Only dead jobs qualify. The job update and its audit entry are one transaction. */
export const retryJob = createServerFn({ method: "POST" })
  .validator((input: unknown) => jobRefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    return withTransaction(sql, async (tx) => {
      const rows = await tx<{ id: string; brand_id: string | null }>`
        update jobs set status = 'queued', attempts = 0, last_error = '', cancel_requested = false,
          lease_until = null, run_after = now(), updated_at = now()
        where id = ${data.jobId} and organization_id = ${data.organizationId} and status = 'dead'
        returning id, brand_id
      `;
      const job = rows[0];
      if (!job) {
        const current = await currentJobStatus(tx, data.organizationId, data.jobId);
        if (!current) throw new Error("That job is not available in this workspace.");
        throw new Error(`Only dead jobs can be retried. This job is ${current.status}.`);
      }
      await tx`insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        values (${crypto.randomUUID()}, ${data.organizationId}, ${job.brand_id}, ${context.userId}, 'job.retried', 'job', ${job.id}, '{}')`;
      return { status: "queued" as const, jobId: job.id };
    });
  });

/**
 * Asks for a queued job to be cancelled, using cancel_requested. The worker never claims a job with cancel_requested set,
 * and moves it to "cancelled" on its next pass. A running job is not cancelled here.
 */
export const cancelJob = createServerFn({ method: "POST" })
  .validator((input: unknown) => jobRefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    return withTransaction(sql, async (tx) => {
      const rows = await tx<{ id: string; brand_id: string | null }>`
        update jobs set cancel_requested = true, updated_at = now()
        where id = ${data.jobId} and organization_id = ${data.organizationId} and status = 'queued' and cancel_requested = false
        returning id, brand_id
      `;
      const job = rows[0];
      if (!job) {
        const current = await currentJobStatus(tx, data.organizationId, data.jobId);
        if (!current) throw new Error("That job is not available in this workspace.");
        if (current.status === "queued" && current.cancelRequested) return { status: "cancel_requested" as const, jobId: data.jobId };
        throw new Error(`Only queued jobs can be cancelled. This job is ${current.status}.`);
      }
      await tx`insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        values (${crypto.randomUUID()}, ${data.organizationId}, ${job.brand_id}, ${context.userId}, 'job.cancel_requested', 'job', ${job.id}, '{}')`;
      return { status: "cancel_requested" as const, jobId: job.id };
    });
  });

const USAGE_ROW_LIMIT = 20_000;
const USAGE_DAY_LIMIT = 90;

type UsageRunRow = UsageRun & { day: string };

function usageRunFromRow(row: Record<string, unknown>): UsageRunRow {
  return {
    operation: String(row.operation ?? "unknown"),
    tokens: row.tokens == null ? null : Number(row.tokens),
    costCents: row.cost_cents == null ? null : Number(row.cost_cents),
    day: utcDay(row.created_at),
  };
}

/**
 * Model usage for one workspace, built on summarizeUsage. A cost total is null when any run in its group has no cost.
 * Totals cover the newest 20,000 runs. `truncated` is true when older runs were left out.
 */
export const listUsage = createServerFn({ method: "POST" })
  .validator((input: unknown) => workspaceInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const rows = await sql<Record<string, unknown>>`
      select operation, tokens, cost_cents, created_at from model_runs
      where organization_id = ${data.organizationId}
      order by created_at desc, id desc limit ${USAGE_ROW_LIMIT + 1}
    `;
    const truncated = rows.length > USAGE_ROW_LIMIT;
    const runs = rows.slice(0, USAGE_ROW_LIMIT).map(usageRunFromRow);
    return {
      usage: { ...summarizeUsage(runs), missingTokens: runs.filter((run) => run.tokens == null).length },
      runs: runs.length,
      truncated,
      rowLimit: USAGE_ROW_LIMIT,
      byOperation: groupUsage(runs, (run) => run.operation)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, ...group }) => ({ operation: key, ...group })),
      daily: groupUsage(runs, (run) => run.day)
        .sort((left, right) => right.key.localeCompare(left.key))
        .slice(0, USAGE_DAY_LIMIT)
        .map(({ key, ...group }) => ({ day: key, ...group })),
    };
  });
