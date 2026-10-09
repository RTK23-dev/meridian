/**
 * Production Jobs Durable Poller
 *
 * Consumes pending production_jobs from PostgreSQL using SELECT ... FOR UPDATE SKIP LOCKED.
 * Resolves the appropriate production provider, polls provider status, collects rendered video
 * artifacts to Google Drive / object storage, evaluates postflight QC, and updates job state.
 */

import type { Sql } from "../learning/store.ts";
import { productionRouter, type ProductionRouter } from "./router.ts";
import { googleDriveClient, type GoogleDriveClient } from "../storage/drive.ts";
import type { ProductionJob } from "./types.ts";
import { finalizeProductionArtifact } from "./artifact-finalizer.ts";

export type PollOptions = {
  limit?: number;
  fetchImpl?: typeof fetch;
  driveClient?: GoogleDriveClient;
  router?: ProductionRouter;
};

export type PollResult = {
  claimed: number;
  polled: number;
  rendered: number;
  failed: number;
};

export async function pollProductionJobs(
  sql: Sql,
  options: PollOptions = {},
): Promise<PollResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const drive = options.driveClient || googleDriveClient;
  const router = options.router || productionRouter;

  // Claim pending jobs atomically. A plain SELECT ... FOR UPDATE outside an explicit
  // transaction releases its row locks as soon as the statement ends, allowing two
  // pollers to submit the same provider request. next_poll_at is the durable lease:
  // a crashed worker makes the job eligible again after two minutes.
  const activeJobs = await sql<{
    id: string;
    organization_id: string;
    brand_id: string;
    provider: string;
    provider_job_id: string | null;
    request_id: string | null;
    status_url: string | null;
    cancel_url: string | null;
    status: string;
    attempt_count: number;
    input: string | Record<string, unknown>;
  }>`
    with candidates as (
      select id
      from production_jobs
      where status in ('QUEUED', 'RUNNING', 'RENDERING', 'SUBMITTING', 'WAITING_FOR_ARTIFACT', 'WAITING_FOR_EXTERNAL_ARTIFACT', 'PENDING_PREFLIGHT', 'STORAGE_PERSISTENCE_FAILED')
        and (next_poll_at is null or next_poll_at <= now())
      order by created_at asc
      limit ${limit}
      for update skip locked
    )
    update production_jobs as jobs
    set next_poll_at = now() + interval '2 minutes', updated_at = now()
    from candidates
    where jobs.id = candidates.id
    returning jobs.id, jobs.organization_id, jobs.brand_id, jobs.provider, jobs.provider_job_id,
              jobs.request_id, jobs.status_url, jobs.cancel_url, jobs.status, jobs.attempt_count, jobs.input
  `;

  const result: PollResult = {
    claimed: activeJobs.length,
    polled: 0,
    rendered: 0,
    failed: 0,
  };

  for (const row of activeJobs) {
    let parsedInput: Record<string, unknown> = {};
    if (typeof row.input === "string") {
      try {
        parsedInput = JSON.parse(row.input) as Record<string, unknown>;
      } catch {
        parsedInput = {};
      }
    } else if (typeof row.input === "object" && row.input !== null) {
      parsedInput = row.input as Record<string, unknown>;
    }

    let provider;
    try {
      provider = router.get(row.provider);
    } catch {
      provider = undefined;
    }

    if (!provider) {
      await sql`
        update production_jobs
        set status = 'FAILED',
            error_code = 'UNKNOWN_PROVIDER',
            updated_at = now()
        where id = ${row.id}
      `;
      result.failed++;
      continue;
    }

    const metadata: Record<string, unknown> = {
      organizationId: row.organization_id,
      brandId: row.brand_id,
      statusUrl: row.status_url,
      cancelUrl: row.cancel_url,
      requestId: row.request_id,
      providerJobId: row.provider_job_id,
      creativeSpec: parsedInput.creativeSpec,
      dropFolderUrl: parsedInput.dropFolderUrl,
    };

    const externalJobId = row.provider_job_id || row.id;
    let polledJob: ProductionJob;

    try {
      polledJob = await provider.checkJobStatus(externalJobId, metadata);
    } catch {
      const newAttempts = (row.attempt_count || 0) + 1;
      await sql`
        update production_jobs
        set attempt_count = ${newAttempts},
            last_polled_at = now(),
            next_poll_at = now() + (least(${newAttempts}, 6) * interval '5 seconds'),
            updated_at = now()
        where id = ${row.id}
      `;
      result.polled++;
      continue;
    }

    if (polledJob.status === "RENDERED" || polledJob.status === "COMPLETED") {
      const runId = typeof parsedInput.runId === "string" ? parsedInput.runId : undefined;
      const durationSeconds = (parsedInput.creativeSpec as any)?.durationTargetSeconds;
      const durationMs = typeof durationSeconds === "number" ? durationSeconds * 1000 : undefined;

      const finalized = await finalizeProductionArtifact(sql, {
        jobId: row.id,
        organizationId: row.organization_id,
        brandId: row.brand_id,
        provider: row.provider,
        providerJobId: row.provider_job_id || undefined,
        runId,
        rawArtifact: {
          uri: polledJob.outputArtifactId,
          base64: (polledJob.metadata?.videoBytesBase64 as string) || undefined,
        },
        options: {
          driveClient: drive,
          fetchImpl,
          durationMs,
          job: polledJob,
        },
      });

      if (finalized.success) {
        result.rendered++;
      } else if (finalized.status === "WAITING_FOR_ARTIFACT") {
        const newAttempts = (row.attempt_count || 0) + 1;
        if (newAttempts < 5) {
          await sql`
            update production_jobs
            set status = 'WAITING_FOR_ARTIFACT',
                attempt_count = ${newAttempts},
                last_polled_at = now(),
                next_poll_at = now() + (least(${newAttempts}, 6) * interval '5 seconds'),
                updated_at = now()
            where id = ${row.id}
          `;
          result.polled++;
        } else {
          await sql`
            update production_jobs
            set status = 'FAILED',
                error_code = 'MISSING_ARTIFACT_BYTES',
                last_polled_at = now(),
                updated_at = now()
            where id = ${row.id}
          `;
          await sql`
            update assets
            set media_status = 'failed',
                lifecycle = 'rejected'
            where generation_run_id = ${runId || ""}
          `;
          result.failed++;
        }
      } else {
        result.failed++;
      }
    } else if (polledJob.status === "FAILED") {
      await sql`
        update production_jobs
        set status = 'FAILED',
            error_code = ${polledJob.errorCode || "PROVIDER_FAILED"},
            last_polled_at = now(),
            updated_at = now()
        where id = ${row.id}
      `;
      await sql`
        update assets
        set media_status = 'failed',
            lifecycle = 'rejected'
        where generation_run_id = ${typeof parsedInput.runId === "string" ? parsedInput.runId : ""}
      `;
      result.failed++;
    } else {
      // In progress
      const newAttempts = (row.attempt_count || 0) + 1;
      await sql`
        update production_jobs
        set status = ${polledJob.status},
            attempt_count = ${newAttempts},
            last_polled_at = now(),
            next_poll_at = now() + (least(${newAttempts}, 6) * interval '5 seconds'),
            updated_at = now()
        where id = ${row.id}
      `;
      result.polled++;
    }
  }

  return result;
}
