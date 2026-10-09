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
import {
  completeVideoJob,
  openVideoReview,
  settleCreativePlanIfComplete,
} from "./materialization.ts";

const POLLER_ACTOR_ID = "production-poller";

/** Records a materialization failure durably. The job stays COMPLETED and unmaterialized, so it is claimed again. */
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
    artifact_id: string | null;
    creative_plan_id: string | null;
    materialized_at: unknown;
  }>`
    with candidates as (
      select id
      from production_jobs
      where (
          status in ('QUEUED', 'RUNNING', 'RENDERING', 'SUBMITTING', 'WAITING_FOR_ARTIFACT', 'WAITING_FOR_EXTERNAL_ARTIFACT', 'PENDING_PREFLIGHT', 'STORAGE_PERSISTENCE_FAILED')
          or (status = 'COMPLETED' and materialized_at is null and artifact_id is not null)
        )
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
              jobs.request_id, jobs.status_url, jobs.cancel_url, jobs.status, jobs.attempt_count, jobs.input,
              jobs.artifact_id, jobs.creative_plan_id, jobs.materialized_at
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
        const materialized = await completeVideoJob(sql, {
          organizationId: row.organization_id,
          brandId: row.brand_id,
          productionJobId: row.id,
        });
        await openVideoReview(sql, {
          organizationId: row.organization_id,
          brandId: row.brand_id,
          creativeId: materialized.creativeId,
          decisionId: materialized.decisionId,
        });
        await settlePlanOf(sql, row);
        result.rendered++;
      } catch (error) {
        await recordMaterializationRetry(sql, row, error);
        result.polled++;
      }
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
          const materialized = await completeVideoJob(sql, {
            organizationId: row.organization_id,
            brandId: row.brand_id,
            productionJobId: row.id,
          });
          await openVideoReview(sql, {
            organizationId: row.organization_id,
            brandId: row.brand_id,
            creativeId: materialized.creativeId,
            decisionId: materialized.decisionId,
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
