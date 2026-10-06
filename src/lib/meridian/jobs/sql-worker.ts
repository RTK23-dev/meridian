import type { Sql } from "@/lib/db";
import { embeddingProviderState } from "../embeddings/provider.ts";
import { collectAdLibrarySource } from "../market/pipeline.ts";
import { syncPublishingStatus } from "../publishing/provider.ts";

type JobRow = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  job_type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
};

async function handle(sql: Sql, job: JobRow): Promise<string> {
  let payload: { organizationId?: string } = {};
  try {
    payload = JSON.parse(job.payload || "{}") as { organizationId?: string };
  } catch {
    payload = {};
  }
  if (payload.organizationId && payload.organizationId !== job.organization_id) {
    throw new Error("Tenant scope violation.");
  }
  if (job.job_type === "learning.update") {
    if (!job.brand_id) throw new Error("Learning needs a brand.");
    const { persistLearnedPatterns } = await import("../machine.ts");
    const count = await persistLearnedPatterns(sql, job.organization_id, job.brand_id, "worker");
    return `patterns:${count}`;
  }
  if (job.job_type === "market.collect") {
    const collected = collectAdLibrarySource();
    return collected.status;
  }
  if (job.job_type === "publishing.sync") {
    return syncPublishingStatus().status;
  }
  if (job.job_type === "embedding.generate") {
    return embeddingProviderState({ openRouterKey: process.env.OPENROUTER_API_KEY }).status;
  }
  if (
    job.job_type === "market.normalize" ||
    job.job_type === "creative.analyze" ||
    job.job_type === "cluster.refresh" ||
    job.job_type === "opportunity.refresh" ||
    job.job_type === "asset.process" ||
    job.job_type === "vision.analyze" ||
    job.job_type === "guardian.check" ||
    job.job_type === "performance.ingest" ||
    job.job_type === "experiment.process" ||
    job.job_type === "notification.dispatch"
  ) {
    return "NO_EXTERNAL_CALL";
  }
  throw new Error(`No handler for ${job.job_type}.`);
}

/** One pass over due jobs. Leases expire so a crashed process can recover them. */
export async function tickSqlJobs(sql: Sql): Promise<{ claimed: number }> {
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
    set status = 'cancelled', updated_at = now()
    where cancel_requested = true and status in ('queued', 'retry')
  `;
  const due = await sql<JobRow>`
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
  for (const job of due) {
    const claimed = await sql<{ id: string }>`
      update jobs
      set status = 'running',
          attempts = attempts + 1,
          lease_until = now() + interval '30 seconds',
          heartbeat_at = now(),
          updated_at = now()
      where id = ${job.id} and status in ('queued', 'retry')
      returning id
    `;
    if (!claimed[0]) continue;
    try {
      const result = await handle(sql, job);
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
            run_after = now() + (power(2, least(attempts, 6)) * interval '1 second'),
            updated_at = now()
        where id = ${job.id} and status = 'running'
      `;
    }
  }
  return { claimed: due.length };
}
