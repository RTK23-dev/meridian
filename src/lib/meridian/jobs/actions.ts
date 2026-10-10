import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { hasRole, isRole } from "@/lib/meridian/access";
import { summarizeUsage } from "@/lib/meridian/observability/usage";
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

function inputText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new Error(`${name} is required.`);
  return value.trim();
}

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

export const retryJob = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: inputText((input as { organizationId?: unknown })?.organizationId, "Workspace"), jobId: inputText((input as { jobId?: unknown })?.jobId, "Job") }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const rows = await sql<{ id: string; brand_id: string | null }>`
      update jobs set status = 'queued', attempts = 0, last_error = '', cancel_requested = false,
        run_after = now(), updated_at = now()
      where id = ${data.jobId} and organization_id = ${data.organizationId} and status = 'dead'
      returning id, brand_id
    `;
    const job = rows[0];
    if (!job) throw new Error("That dead-letter job is no longer available.");
    await sql`insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${crypto.randomUUID()}, ${data.organizationId}, ${job.brand_id}, ${context.userId}, 'job.retried', 'job', ${job.id}, '{}')`;
    return { status: "queued" as const };
  });

export const cancelJob = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: inputText((input as { organizationId?: unknown })?.organizationId, "Workspace"), jobId: inputText((input as { jobId?: unknown })?.jobId, "Job") }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const rows = await sql<{ id: string }>`
      update jobs set cancel_requested = true, updated_at = now()
      where id = ${data.jobId} and organization_id = ${data.organizationId} and status in ('queued', 'retry')
      returning id
    `;
    if (!rows[0]) throw new Error("Only queued or retrying jobs can be cancelled.");
    await sql`insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${crypto.randomUUID()}, ${data.organizationId}, null, ${context.userId}, 'job.cancel_requested', 'job', ${rows[0].id}, '{}')`;
    return { status: "cancel_requested" as const };
  });

export const listUsage = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: inputText((input as { organizationId?: unknown })?.organizationId, "Workspace") }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const rows = await sql<Record<string, unknown>>`
      select operation, tokens, cost_cents, created_at from model_runs
      where organization_id = ${data.organizationId}
      order by created_at desc limit 20_000
    `;
    const runs = rows.map((row) => ({
      operation: String(row.operation ?? "unknown"),
      tokens: row.tokens == null ? null : Number(row.tokens),
      costCents: row.cost_cents == null ? null : Number(row.cost_cents),
      createdAt: String(row.created_at),
    }));
    const byDay = new Map<string, { tokens: number; knownCost: number; missingCost: number }>();
    const byOperation = new Map<string, { tokens: number; knownCost: number; missingCost: number }>();
    for (const run of runs) {
      const day = run.createdAt.slice(0, 10);
      const total = byDay.get(day) ?? { tokens: 0, knownCost: 0, missingCost: 0 };
      total.tokens += run.tokens ?? 0;
      if (run.costCents == null) total.missingCost += 1;
      else total.knownCost += run.costCents;
      byDay.set(day, total);

      const operation = byOperation.get(run.operation) ?? { tokens: 0, knownCost: 0, missingCost: 0 };
      operation.tokens += run.tokens ?? 0;
      if (run.costCents == null) operation.missingCost += 1;
      else operation.knownCost += run.costCents;
      byOperation.set(run.operation, operation);
    }
    return {
      usage: summarizeUsage(runs),
      runs: runs.length,
      byOperation: [...byOperation.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([operation, value]) => ({
        operation, tokens: value.tokens, costCents: value.missingCost === 0 ? value.knownCost : null,
      })),
      daily: [...byDay.entries()].sort(([left], [right]) => right.localeCompare(left)).slice(0, 90).map(([day, value]) => ({
        day, tokens: value.tokens, costCents: value.missingCost === 0 ? value.knownCost : null,
      })),
    };
  });
