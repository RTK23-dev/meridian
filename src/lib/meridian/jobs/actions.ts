import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { hasRole, isRole } from "@/lib/meridian/access";

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

export const listJobs = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: inputText((input as { organizationId?: unknown })?.organizationId, "Workspace") }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireAdmin(context.userId, data.organizationId);
    const [rows, beats, counts] = await Promise.all([
      sql<Record<string, unknown>>`
        select j.id, j.brand_id, b.name as brand_name, j.job_type, j.status, j.attempts, j.max_attempts,
               j.last_error, j.payload, j.created_at, j.updated_at, j.run_after, j.cancel_requested
        from jobs j left join brands b on b.id = j.brand_id and b.organization_id = j.organization_id
        where j.organization_id = ${data.organizationId}
        order by j.created_at desc limit 100
      `,
      sql<{ name: string; beat_at: string }>`select name, beat_at from process_heartbeats where name in ('worker', 'scheduler')`,
      sql<{ status: string; count: number }>`select status, count(*) as count from jobs where organization_id = ${data.organizationId} group by status`,
    ]);
    const now = Date.now();
    const heartbeat = (name: string) => {
      const time = Date.parse(String(beats.find((beat) => beat.name === name)?.beat_at ?? ""));
      return Number.isFinite(time) && now - time < 30_000 ? "running" : "stopped";
    };
    return {
      worker: heartbeat("worker"),
      scheduler: heartbeat("scheduler"),
      counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
      jobs: rows.map((row) => {
        let payloadKeys: string[] = [];
        try { const value = JSON.parse(String(row.payload ?? "{}")) as unknown; if (value && typeof value === "object" && !Array.isArray(value)) payloadKeys = Object.keys(value); } catch { /* payload details stay hidden when malformed */ }
        return {
          id: String(row.id), brandName: String(row.brand_name ?? "Workspace job"), jobType: String(row.job_type),
          status: String(row.status), attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
          error: String(row.last_error ?? ""), payloadKeys, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
          runAfter: String(row.run_after ?? ""), cancelRequested: row.cancel_requested === true || row.cancel_requested === "t",
        };
      }),
    };
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
