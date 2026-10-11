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
import {
  SUBMISSION_EXPIRED_CODE,
  SUBMISSION_REVIEW_CODE,
  classifySubmissionEvidence,
  evidenceFromProviderStatus,
  submissionEvidenceDue,
  type SubmissionEvidence,
} from "./submission-reconciliation.ts";

const POLLER_ACTOR_ID = "production-poller";

/** Records a materialization failure durably. The job stays COMPLETED and unmaterialized, so it is claimed again. */
function toIsoOrNull(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Attempts before a job whose render cannot be stored durably is failed. */
export const MAX_STORAGE_PERSISTENCE_ATTEMPTS = 5;

/** Pure retry decision for a render that could not be stored. Exported so the bound is tested without a provider. */
export function storageRetryAction(previousAttempts: number): { action: "retry" | "fail"; attempts: number } {
  const attempts = previousAttempts + 1;
  return { action: attempts < MAX_STORAGE_PERSISTENCE_ATTEMPTS ? "retry" : "fail", attempts };
}

/**
 * Polls one job may receive before a transient status-check failure is terminal. attempt_count counts every poll of the job,
 * including healthy ones, and a render is polled about every 30 seconds. So 240 polls is about two hours, longer than any render
 * this worker is expected to wait for, and a job that cannot be read for that long is reconciled rather than polled forever.
 */
export const MAX_PROVIDER_POLL_ATTEMPTS = 240;

/** A job still unreadable this long after submission is terminal, whatever its attempt count. Twenty-four hours is past any render. */
export const MAX_PROVIDER_POLL_AGE_MS = 24 * 60 * 60 * 1000;

/** A transient retry waits least(attempts, 6) * 30 seconds, so it backs off to three minutes. */
const PROVIDER_RETRY_STEP_SECONDS = 30;

export type ProviderPollFailure = {
  /** A permanent failure cannot succeed on retry, so the job leaves the queue at once. */
  permanent: boolean;
  errorCode: string;
  reason: string;
};

const CONTRACT_FAILURES: Record<string, ProviderPollFailure> = {
  INVALID_JOB_ID: {
    permanent: true,
    errorCode: "PROVIDER_JOB_ID_INVALID",
    reason: "The stored provider job id is not one the provider can be asked about, so no status check was made.",
  },
  MALFORMED_RESPONSE: {
    permanent: true,
    errorCode: "PROVIDER_CONTRACT_MISMATCH",
    reason: "The provider's status response did not match the expected contract.",
  },
  REDIRECT_REFUSED: {
    permanent: true,
    errorCode: "PROVIDER_REDIRECT_REFUSED",
    reason: "The provider redirected a status check. The workspace key was not sent to the redirect target.",
  },
};

/**
 * Classifies a failed status check. The class comes from the adapter's contract code or HTTP status, never from message text.
 * 401, 403, 404, other 4xx except 408 and 429, redirects and contract failures are permanent. 408, 429, 5xx, and any error with
 * no status (a network failure, a timeout, or another adapter's error) are transient, and transient failures are still bounded.
 */
export function classifyProviderPollError(error: unknown): ProviderPollFailure {
  const fields = typeof error === "object" && error !== null ? (error as { code?: unknown; status?: unknown }) : {};
  if (typeof fields.code === "string" && Object.hasOwn(CONTRACT_FAILURES, fields.code)) {
    return CONTRACT_FAILURES[fields.code]!;
  }
  const status = fields.status;
  if (typeof status === "number" && Number.isInteger(status)) {
    if (status === 401 || status === 403) {
      return {
        permanent: true,
        errorCode: "PROVIDER_AUTH_REJECTED",
        reason: `The provider rejected the workspace's key for this status check (HTTP ${status}). Restore a valid key for this workspace.`,
      };
    }
    if (status === 404) {
      return { permanent: true, errorCode: "PROVIDER_JOB_NOT_FOUND", reason: "The provider does not recognise this request (HTTP 404)." };
    }
    if (status === 429) {
      return { permanent: false, errorCode: "PROVIDER_RATE_LIMITED", reason: "The provider rate-limited the status check (HTTP 429)." };
    }
    if (status === 408 || (status >= 500 && status <= 599)) {
      return { permanent: false, errorCode: "PROVIDER_UNAVAILABLE", reason: `The provider did not answer the status check (HTTP ${status}).` };
    }
    if (status >= 300 && status <= 499) {
      return { permanent: true, errorCode: "PROVIDER_REQUEST_REJECTED", reason: `The provider rejected the status check (HTTP ${status}).` };
    }
  }
  return { permanent: false, errorCode: "PROVIDER_POLL_FAILED", reason: "The status check failed without an HTTP answer." };
}

export type ProviderPollDecision =
  | { action: "retry"; delaySeconds: number }
  | { action: "reconcile"; errorCode: string; reason: string };

/**
 * Decides what a failed status check does to its job. A permanent failure reconciles at once. A transient one retries until the
 * attempt bound or the age bound is reached, then reconciles. Reconciliation is terminal for the poller and never releases money.
 */
export function providerPollDecision(input: { failure: ProviderPollFailure; attempts: number; ageMs: number }): ProviderPollDecision {
  const { failure, attempts, ageMs } = input;
  const outcome = " The render's outcome is unknown, so its reservation is held. Resolve the cause, then reconcile the held reservation.";
  if (failure.permanent) {
    return { action: "reconcile", errorCode: failure.errorCode, reason: `${failure.reason}${outcome}` };
  }
  if (attempts >= MAX_PROVIDER_POLL_ATTEMPTS) {
    return {
      action: "reconcile",
      errorCode: "POLL_RETRY_EXHAUSTED",
      reason: `Status checks failed on ${attempts} polls. Last: ${failure.reason}${outcome}`,
    };
  }
  if (ageMs >= MAX_PROVIDER_POLL_AGE_MS) {
    return {
      action: "reconcile",
      errorCode: "POLL_RETRY_EXHAUSTED",
      reason: `The job has not been readable for 24 hours. Last: ${failure.reason}${outcome}`,
    };
  }
  return { action: "retry", delaySeconds: Math.min(attempts, 6) * PROVIDER_RETRY_STEP_SECONDS };
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

function parseJobInput(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null ? value : {};
}

/** The fields a provider status check receives for one stored job. */
function pollMetadataOf(
  row: {
    organization_id: string;
    brand_id: string;
    status_url: string | null;
    cancel_url: string | null;
    request_id: string | null;
    provider_job_id: string | null;
    created_at: unknown;
  },
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    statusUrl: row.status_url,
    cancelUrl: row.cancel_url,
    requestId: row.request_id,
    providerJobId: row.provider_job_id,
    creativeSpec: input.creativeSpec,
    dropFolderUrl: input.dropFolderUrl,
    // When the job was submitted. A manual handoff expires from this time.
    createdAt: toIsoOrNull(row.created_at),
  };
}

/** How long a job whose submission is still unknown waits before the pass asks the provider again. */
const SUBMISSION_RECHECK_SECONDS = 15 * 60;

type UnknownSubmissionRow = {
  id: string;
  organization_id: string;
  brand_id: string;
  provider: string;
  provider_job_id: string | null;
  request_id: string | null;
  status_url: string | null;
  cancel_url: string | null;
  modality: string;
  creative_plan_id: string | null;
  input: string | Record<string, unknown>;
  created_at: unknown;
  /** Milliseconds since submission, on the database clock. */
  age_ms: string | number | null;
};

function evidenceDetail(evidence: SubmissionEvidence): { errorCode: string; reason: string } {
  if (evidence.kind === "accepted") return { errorCode: "", reason: "" };
  return { errorCode: evidence.errorCode ?? "", reason: evidence.reason ?? "" };
}

/**
 * The provider's answer about one unknown submission. Only a video job with a stored provider id can be asked: the Meridian job
 * id is not the provider's id, and no provider looks a job up by it. A job without one has no evidence, and waits for the bound.
 */
async function gatherSubmissionEvidence(
  row: UnknownSubmissionRow,
  input: Record<string, unknown>,
  router: ProductionRouter,
): Promise<SubmissionEvidence> {
  if (row.modality !== "video" || !row.provider_job_id) return { kind: "none" };
  let provider;
  try {
    provider = router.get(row.provider);
  } catch {
    provider = undefined;
  }
  if (!provider) return { kind: "none" };
  try {
    const answer = await provider.checkJobStatus(row.provider_job_id, pollMetadataOf(row, input));
    return evidenceFromProviderStatus({
      status: answer.status,
      providerJobId: row.provider_job_id,
      errorCode: answer.errorCode,
      error: answer.error,
    });
  } catch (error) {
    const failure = classifyProviderPollError(error);
    // A permanent refusal cannot show whether the job was accepted, so a person looks. A transient one is retried until the bound.
    return failure.permanent
      ? { kind: "ambiguous", errorCode: failure.errorCode, reason: failure.reason }
      : { kind: "none", errorCode: failure.errorCode, reason: failure.reason };
  }
}

/**
 * The submission reconciliation pass. It claims the jobs whose submission outcome is unknown, gathers the evidence for each, and
 * applies the outcome:
 * - CONFIRMED: the job returns to the queue with its provider job id.
 * - FAILED: the job is failed with the provider's error. Its reservation stays held.
 * - EXPIRED or REVIEW: the job is marked for a person, and the pass never claims it again.
 * This pass never touches a budget reservation. Whatever the outcome, the spend is released or settled only by an operator.
 */
async function reconcileSubmissions(
  sql: Sql,
  options: { scope: string | null; router: ProductionRouter; limit: number },
): Promise<{ claimed: number; polled: number; failed: number }> {
  const rows = await sql<UnknownSubmissionRow>`
    with candidates as (
      select id
      from production_jobs
      where status = 'SUBMISSION_UNKNOWN'
        and (error_code is null or error_code not in (${SUBMISSION_REVIEW_CODE}, ${SUBMISSION_EXPIRED_CODE}))
        and (next_poll_at is null or next_poll_at <= now())
        and (${options.scope}::text is null or organization_id = ${options.scope})
      order by created_at asc
      limit ${options.limit}
      for update skip locked
    )
    update production_jobs as jobs
    set next_poll_at = now() + interval '2 minutes', updated_at = now()
    from candidates
    where jobs.id = candidates.id
    returning jobs.id, jobs.organization_id, jobs.brand_id, jobs.provider, jobs.provider_job_id, jobs.request_id,
              jobs.status_url, jobs.cancel_url, jobs.modality, jobs.creative_plan_id, jobs.input, jobs.created_at,
              extract(epoch from (now() - jobs.created_at)) * 1000 as age_ms
  `;

  const result = { claimed: rows.length, polled: 0, failed: 0 };
  for (const row of rows) {
    const ageMs = Number(row.age_ms ?? 0);
    const input = parseJobInput(row.input);
    const evidence = await gatherSubmissionEvidence(row, input, options.router);

    if (!submissionEvidenceDue({ evidence, ageMs })) {
      // No evidence yet, inside the bound. The job keeps its status and is checked again later. A transient failure's reason is
      // recorded, so an operator can see why the job is still waiting.
      if (evidence.kind === "none" && evidence.reason) {
        await sql`
          update production_jobs
          set error_code = ${evidence.errorCode ?? null}, error_message = ${evidence.reason.slice(0, 500)},
              next_poll_at = now() + (${SUBMISSION_RECHECK_SECONDS} * interval '1 second'), updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id} and status = 'SUBMISSION_UNKNOWN'
        `;
      } else {
        await sql`
          update production_jobs
          set next_poll_at = now() + (${SUBMISSION_RECHECK_SECONDS} * interval '1 second'), updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id} and status = 'SUBMISSION_UNKNOWN'
        `;
      }
      result.polled++;
      continue;
    }

    const outcome = classifySubmissionEvidence({ evidence, ageMs });
    const { errorCode, reason } = evidenceDetail(evidence);
    if (outcome === "CONFIRMED") {
      // The provider holds the job under the stored id, so it goes back to the normal queue, to be polled on its next turn.
      await sql`
        update production_jobs
        set status = 'QUEUED', error_code = null, error_message = null, next_poll_at = now() + interval '1 minute', updated_at = now()
        where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id} and status = 'SUBMISSION_UNKNOWN'
      `;
      result.polled++;
    } else if (outcome === "FAILED") {
      // The job was accepted before it failed, so it may have been billed. Its reservation is held, not released.
      await sql`
        update production_jobs
        set status = 'FAILED', error_code = ${errorCode || "PROVIDER_FAILED"},
            error_message = ${`${reason} The reservation is held for an operator: the job was accepted before it failed, so it may have been billed.`.slice(0, 500)},
            last_polled_at = now(), next_poll_at = null, updated_at = now()
        where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id} and status = 'SUBMISSION_UNKNOWN'
      `;
      await settlePlanOf(sql, row);
      result.failed++;
    } else {
      // EXPIRED or REVIEW. The job stays SUBMISSION_UNKNOWN, which is the operator's queue, with the reason. Its reservation is not
      // touched: the provider's outcome is unknown, and only an operator may release or settle it. The plan is not settled, because
      // the job is not terminal.
      const lead = outcome === "EXPIRED" ? "No provider evidence arrived within 24 hours." : "The provider's answer does not settle this submission.";
      const detail = reason || "No provider job id was stored, so the provider cannot be asked about this submission.";
      await sql`
        update production_jobs
        set error_code = ${outcome === "EXPIRED" ? SUBMISSION_EXPIRED_CODE : SUBMISSION_REVIEW_CODE},
            error_message = ${`${lead} ${detail} The reservation is held for an operator to resolve; automation has not released or settled it.`.slice(0, 500)},
            last_polled_at = now(), next_poll_at = null, updated_at = now()
        where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id} and status = 'SUBMISSION_UNKNOWN'
      `;
      result.failed++;
    }
  }
  return result;
}

export type PollOptions = {
  limit?: number;
  /** Claim only this organization's jobs. Omitted, the worker claims across every tenant, as it does in production. */
  organizationId?: string;
  /** A test transport for artifact downloads. Omitted, as in production, downloads connect to their validated addresses. */
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
  const drive = options.driveClient || defaultArtifactDrive();
  const router = options.router || productionRouter;
  const scope = options.organizationId ?? null;

  // Jobs whose submission outcome is unknown run first. A job they confirm is queued for a later turn, so it is not polled twice in one pass.
  const submissions = await reconcileSubmissions(sql, { scope, router, limit });

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
    created_at: unknown;
    /** Milliseconds since submission, on the database clock. The age bound uses it, so the worker's clock is not trusted. */
    age_ms: string | number | null;
  }>`
    with candidates as (
      select id
      from production_jobs
      where (
          status in ('QUEUED', 'RUNNING', 'RENDERING', 'SUBMITTING', 'AWAITING_CHILDREN', 'WAITING_FOR_ARTIFACT', 'WAITING_FOR_EXTERNAL_ARTIFACT', 'PENDING_PREFLIGHT', 'STORAGE_PERSISTENCE_FAILED')
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
              jobs.artifact_id, jobs.creative_plan_id, jobs.materialized_at, jobs.modality, jobs.created_at,
              extract(epoch from (now() - jobs.created_at)) * 1000 as age_ms
  `;

  const result: PollResult = {
    claimed: activeJobs.length + submissions.claimed,
    polled: submissions.polled,
    rendered: 0,
    failed: submissions.failed,
  };

  for (const row of activeJobs) {
    const parsedInput = parseJobInput(row.input);

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

    const metadata = pollMetadataOf(row, parsedInput);

    const externalJobId = row.provider_job_id || row.id;
    let polledJob: ProductionJob;

    try {
      polledJob = await provider.checkJobStatus(externalJobId, metadata);
    } catch (error) {
      const failure = classifyProviderPollError(error);
      const attempts = (row.attempt_count || 0) + 1;
      const decision = providerPollDecision({ failure, attempts, ageMs: Number(row.age_ms ?? 0) });
      if (decision.action === "retry") {
        await sql`
          update production_jobs
          set attempt_count = ${attempts},
              error_code = ${failure.errorCode},
              error_message = ${failure.reason},
              last_polled_at = now(),
              next_poll_at = now() + (${decision.delaySeconds} * interval '1 second'),
              updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id}
        `;
        result.polled++;
      } else {
        // The job becomes SUBMISSION_UNKNOWN. The submission reconciliation pass checks its provider id once more on its next run, and a
        // refusal then marks it for a person. Its reservation is not released or settled here: the provider's outcome is unknown, and
        // releasing could hide a real charge. The plan is not settled either, because its job is not terminal.
        await sql`
          update production_jobs
          set status = 'SUBMISSION_UNKNOWN',
              error_code = ${decision.errorCode},
              error_message = ${decision.reason},
              attempt_count = ${attempts},
              last_polled_at = now(),
              next_poll_at = null,
              updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id}
        `;
        result.failed++;
      }
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
          fetchImpl: options.fetchImpl,
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
      } else if (finalized.status === "FAILED") {
        // The provider reported the render complete, so it may be billed. Its artifact URL was refused or was too large, and
        // retrying the same URL cannot help. The job fails with that reason, and its reservation stays held for reconciliation.
        await sql`
          update production_jobs
          set status = 'FAILED',
              error_code = ${finalized.errorCode ?? "ARTIFACT_NOT_STORED"},
              error_message = ${finalized.error ?? "The provider's artifact could not be stored."},
              last_polled_at = now(),
              updated_at = now()
          where id = ${row.id} and organization_id = ${row.organization_id} and brand_id = ${row.brand_id}
        `;
        await settlePlanOf(sql, row);
        result.failed++;
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
      // A successful answer replaces the error recorded by an earlier transient failure. A non-terminal answer that carries an
      // error, such as a Drive scan that could not run, is recorded here, so operators see why the job is still waiting.
      const pendingError = polledJob.error ? String(polledJob.error) : "";
      await sql`
        update production_jobs
        set status = ${polledJob.status},
            attempt_count = ${newAttempts},
            error_code = ${pendingError ? pendingError.split(":")[0] : null},
            error_message = ${pendingError ? pendingError.slice(0, 500) : null},
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
