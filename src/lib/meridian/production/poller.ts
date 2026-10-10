/**
 * Production Jobs Durable Poller
 *
 * Consumes pending production_jobs from PostgreSQL using SELECT ... FOR UPDATE SKIP LOCKED.
 * Resolves the appropriate production provider, polls provider status, collects rendered video
 * artifacts to Google Drive / object storage, evaluates postflight QC, and updates job state.
 */

import type { Sql } from "../learning/store.ts";
import { productionRouter, type ProductionRouter } from "./router.ts";
import { defaultArtifactDrive, type ArtifactDrive } from "../storage/artifact-drive.ts";
import type { ProductionJob } from "./types.ts";
import { finalizeProductionArtifact } from "./artifact-finalizer.ts";
import { completeProductionJob, settleCarouselParent, settleCreativePlanIfComplete } from "./materialization.ts";

const POLLER_ACTOR_ID = "production-poller";

/** Records a materialization failure durably. The job stays COMPLETED and unmaterialized, so it is claimed again. */
/** Attempts before a job whose render cannot be stored durably is failed. */
export const MAX_STORAGE_PERSISTENCE_ATTEMPTS = 5;

/** Pure retry decision for a render that could not be stored. Exported so the bound is tested without a provider. */
export function storageRetryAction(previousAttempts: number): { action: "retry" | "fail"; attempts: number } {
  const attempts = previousAttempts + 1;
  return { action: attempts < MAX_STORAGE_PERSISTENCE_ATTEMPTS ? "retry" : "fail", attempts };
}

async function recordMaterializationRetry(
  sql: Sql,
  row: { id: string; organization_id: string; brand_id: string; attempt_count: number },
  error: unknown,
) {
  const attempts = (row.attempt_count || 0) + 1;
  await sql`
    update production_jobs
    set attempt_count = ${attempts},
        error_message = ${error instanceof Error ? error.message : String(error)},
        next_poll_at = now() + (least(${attempts}, 6) * interval '30 seconds'),
        updated_at = now()
    where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id}
  `;
}

/** Settles the plan a job belongs to, if any. Called whenever a job reaches a terminal state. */
async function settlePlanOf(
  sql: Sql,
  row: { organization_id: string; brand_id: string; creative_plan_id: string | null },
) {
  if (!row.creative_plan_id) return;
  await settleCreativePlanIfComplete(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    planId: row.creative_plan_id,
    actorId: POLLER_ACTOR_ID,
  });
}

export type PollOptions = {
  limit?: number;
  /** Claim only this organization's jobs. Omitted, the worker claims across every tenant, as it does in production. */
  organizationId?: string;
  fetchImpl?: typeof fetch;
  driveClient?: ArtifactDrive;
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
  const drive = options.driveClient || defaultArtifactDrive();
  const router = options.router || productionRouter;
  const scope = options.organizationId ?? null;

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
    artifact_id: string | null;
    creative_plan_id: string | null;
    materialized_at: unknown;
    modality: string;
  }>`
    with candidates as (
      select id
      from production_jobs
      where (
          status in ('QUEUED', 'RUNNING', 'RENDERING', 'SUBMITTING', 'WAITING_FOR_ARTIFACT', 'WAITING_FOR_EXTERNAL_ARTIFACT', 'PENDING_PREFLIGHT', 'STORAGE_PERSISTENCE_FAILED')
          or (status = 'COMPLETED' and materialized_at is null and artifact_id is not null)
        )
        and (next_poll_at is null or next_poll_at <= now())
        and (${scope}::text is null or organization_id = ${scope})
      order by created_at asc
      limit ${limit}
      for update skip locked
    )
    update production_jobs as jobs
    set next_poll_at = now() + interval '2 minutes', updated_at = now()
    from candidates
    where jobs.id = candidates.id
    returning jobs.id, jobs.organization_id, jobs.brand_id, jobs.provider, jobs.provider_job_id,
              jobs.request_id, jobs.status_url, jobs.cancel_url, jobs.status, jobs.attempt_count, jobs.input,
              jobs.artifact_id, jobs.creative_plan_id, jobs.materialized_at, jobs.modality
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

    if (row.status === "COMPLETED") {
      // Finalized on an earlier pass but not yet materialized. Finish it without contacting the provider.
      try {
        await completeProductionJob(
          sql,
          { organizationId: row.organization_id, brandId: row.brand_id, productionJobId: row.id },
          { driveClient: drive },
        );
        await settlePlanOf(sql, row);
        result.rendered++;
      } catch (error) {
        await recordMaterializationRetry(sql, row, error);
        result.polled++;
      }
      continue;
    }

    if (row.modality === "carousel") {
      // A carousel has no provider call of its own. It settles from its slides, which the executor or the poller completes.
      try {
        const outcome = await settleCarouselParent(sql, {
          organizationId: row.organization_id,
          brandId: row.brand_id,
          productionJobId: row.id,
        });
        if (outcome === "completed") result.rendered++;
        else if (outcome === "incomplete") result.failed++;
        else result.polled++;
        if (outcome === "completed" || outcome === "incomplete") await settlePlanOf(sql, row);
      } catch (error) {
        await recordMaterializationRetry(sql, row, error);
        result.polled++;
      }
      continue;
    }

    if (row.modality !== "video") {
      // An image is generated in one call and its bytes are not retained, so there is nothing to poll. A job still
      // SUBMITTING here was interrupted around its provider call, so the call may have happened. It is marked ambiguous and
      // its reservation stays held for reconciliation. It is never resubmitted, because that could spend twice.
      if (row.status === "SUBMITTING") {
        await sql`
          update production_jobs
          set status = 'SUBMISSION_UNKNOWN',
              error_code = 'INTERRUPTED_IMAGE_SUBMISSION',
              error_message = 'The worker stopped around an image provider call. The call may have been made; the reservation is held for reconciliation.',
              updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id}
        `;
      } else {
        await sql`
          update production_jobs
          set status = 'FAILED',
              error_code = 'IMAGE_NOT_RESUMABLE',
              error_message = 'An image job cannot be resumed from the poller. Its bytes were not retained.',
              updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id}
        `;
        await settlePlanOf(sql, row);
      }
      result.failed++;
      continue;
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
          // The durable input is authoritative for the spec; a provider need not echo it back.
          job: { ...polledJob, creativeSpec: polledJob.creativeSpec ?? (parsedInput.creativeSpec as ProductionJob["creativeSpec"]) },
        },
      });

      if (finalized.success) {
        try {
          await completeProductionJob(sql, {
            organizationId: row.organization_id,
            brandId: row.brand_id,
            productionJobId: row.id,
          });
          await settlePlanOf(sql, row);
          result.rendered++;
        } catch (error) {
          await recordMaterializationRetry(sql, row, error);
          result.polled++;
        }
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
          // Billing is uncertain for an accepted render, so the reservation stays held for reconciliation.
          await settlePlanOf(sql, row);
          result.failed++;
        }
      } else if (finalized.status === "STORAGE_PERSISTENCE_FAILED") {
        // The render exists but was not stored durably. Retry with backoff, and fail the job once retries are exhausted,
        // so the plan can settle. The provider accepted the render and may have billed it, so the reservation is held.
        const retry = storageRetryAction(row.attempt_count || 0);
        if (retry.action === "retry") {
          await sql`
            update production_jobs
            set attempt_count = ${retry.attempts},
                error_code = 'STORAGE_PERSISTENCE_FAILED',
                last_polled_at = now(),
                next_poll_at = now() + (least(${retry.attempts}, 6) * interval '30 seconds'),
                updated_at = now()
            where id = ${row.id}
          `;
          result.polled++;
        } else {
          await sql`
            update production_jobs
            set status = 'FAILED',
                attempt_count = ${retry.attempts},
                error_code = 'STORAGE_RETRY_EXHAUSTED',
                last_polled_at = now(),
                updated_at = now()
            where id = ${row.id}
          `;
          await settlePlanOf(sql, row);
          result.failed++;
        }
      } else {
        await settlePlanOf(sql, row);
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
      // A provider-side failure after acceptance may still have been billed. Its reservation is held, not released.
      await settlePlanOf(sql, row);
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
