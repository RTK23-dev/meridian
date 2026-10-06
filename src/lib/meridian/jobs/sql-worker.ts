import type { Sql } from "../learning/store.ts";
import { executeJob, type ExecutableJob } from "./execute.ts";

let stopping = false;
const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;

export async function executeWithLease(
  sql: Sql,
  job: ExecutableJob,
  execute: (sql: Sql, job: ExecutableJob) => Promise<string> = executeJob,
  heartbeatMs = HEARTBEAT_MS,
): Promise<string> {
  const heartbeat = setInterval(() => {
    void sql`
      update jobs
      set lease_until = now() + ${LEASE_SECONDS}::int * interval '1 second', heartbeat_at = now()
      where id = ${job.id} and status = 'running'
    `.catch(() => undefined);
  }, heartbeatMs);
  try {
    return await execute(sql, job);
  } finally {
    clearInterval(heartbeat);
  }
}

export function requestWorkerStop(): void {
  stopping = true;
}

export function resetWorkerStop(): void {
  stopping = false;
}

/** One pass over due jobs. The web process must not call this. */
export async function tickSqlJobs(sql: Sql): Promise<{ claimed: number; stopped: boolean }> {
  if (stopping) return { claimed: 0, stopped: true };
  await sql`
    update jobs
    set status = case when attempts >= max_attempts then 'dead' else 'retry' end,
        last_error = 'Lease expired before the worker finished.',
        lease_until = null,
        updated_at = now()
    where status = 'running' and lease_until is not null and lease_until < now()
  `;
  await sql`
    update jobs
    set status = 'cancelled', updated_at = now(), lease_until = null
    where cancel_requested = true and status in ('queued', 'retry')
  `;
  const due = await sql<ExecutableJob>`
    select id, organization_id, brand_id, job_type, payload, attempts, max_attempts
    from jobs
    where status in ('queued', 'retry')
      and run_after <= now()
      and cancel_requested = false
      and (depends_on = '' or exists (
        select 1 from jobs parent where parent.id = jobs.depends_on and parent.status = 'succeeded'
      ))
    order by priority asc, created_at asc
    limit 4
  `;
  let claimed = 0;
  for (const job of due) {
    if (stopping) return { claimed, stopped: true };
    const locked = await sql<{ id: string }>`
      update jobs
      set status = 'running',
          attempts = attempts + 1,
          lease_until = now() + ${LEASE_SECONDS}::int * interval '1 second',
          heartbeat_at = now(),
          updated_at = now()
      where id = ${job.id} and status in ('queued', 'retry')
      returning id
    `;
    if (!locked[0]) continue;
    claimed += 1;
    try {
      const result = await executeWithLease(sql, job);
      await sql`
        update jobs
        set status = 'succeeded', result = ${result}, lease_until = null, last_error = '', updated_at = now()
        where id = ${job.id} and status = 'running'
      `;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed.";
      const attempts = job.attempts + 1;
      const dead = attempts >= job.max_attempts;
      await sql`
        update jobs
        set status = ${dead ? "dead" : "retry"},
            last_error = ${message.slice(0, 500)},
            lease_until = null,
            run_after = now() + (power(2, least(${attempts}, 6)) * interval '1 second'),
            updated_at = now()
        where id = ${job.id} and status = 'running'
      `;
    }
  }
  return { claimed, stopped: false };
}

/** Runs one queued job by id. The studio uses the same executor as the worker. */
export async function claimAndRun(sql: Sql, jobId: string): Promise<string> {
  const due = await sql<ExecutableJob>`
    select id, organization_id, brand_id, job_type, payload, attempts, max_attempts
    from jobs
    where id = ${jobId} and status in ('queued', 'retry')
    limit 1
  `;
  const job = due[0];
  if (!job) return "skipped";
  const locked = await sql<{ id: string }>`
    update jobs
    set status = 'running', attempts = attempts + 1, lease_until = now() + ${LEASE_SECONDS}::int * interval '1 second',
        heartbeat_at = now(), updated_at = now()
    where id = ${job.id} and status in ('queued', 'retry')
    returning id
  `;
  if (!locked[0]) return "skipped";
  try {
    const result = await executeWithLease(sql, job);
    await sql`
      update jobs set status = 'succeeded', result = ${result}, lease_until = null, last_error = '', updated_at = now()
      where id = ${job.id} and status = 'running'
    `;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job failed.";
    const attempts = job.attempts + 1;
    const dead = attempts >= job.max_attempts;
    await sql`
      update jobs
      set status = ${dead ? "dead" : "retry"}, last_error = ${message.slice(0, 500)}, lease_until = null,
          run_after = now() + (power(2, least(${attempts}, 6)) * interval '1 second'), updated_at = now()
      where id = ${job.id} and status = 'running'
    `;
    return dead ? `dead:${message}` : `retry:${message}`;
  }
}
