/**
 * The trial reel's second step (NORTH_STAR section 8, item B4), SQL part. The publish records the trial step with recordTrialStep, which
 * schedules a check through the job queue. Each check reads the reel's documented fields, decides the feed step with trialCheckOutcome
 * (trial.ts), stores the result, and schedules the next check while the reel has not graduated and the limit is not reached.
 *
 * Every query is filtered by the job's organization and brand. The access token is resolved from the stored account at check time and is
 * not written to the job payload, the trial row or a log.
 */
import type { Sql } from "../learning/store.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { resolveOrganicConnection } from "./connection.ts";
import { readInstagramTrial } from "./instagram.ts";
import {
  TRIAL_CHECK_DELAY_SECONDS,
  TRIAL_CHECK_MAX_CHECKS,
  documentedGraduationReader,
  trialCheckOutcome,
  type GraduationReader,
  type TrialGraduationStrategy,
  type TrialReading,
  type TrialFeedStatus,
} from "./trial.ts";

/** The job type the executor dispatches to runTrialCheckJob (jobs/execute.ts). */
export const TRIAL_CHECK_JOB = "distribution.trial_check";

export type TrialCheckDeps = {
  /** Defaults to the live transport. Tests pass a recorded transport. */
  transport?: Transport;
  /** Defaults to the documented reader, which never reads a graduation. Tests pass a reader to exercise the feed step. */
  reader?: GraduationReader;
  now?: Date;
};

/**
 * Records the trial step of a published Reel: one row that links the organic_posts receipt to the Instagram media id, and the first
 * scheduled check. Called only after the provider confirmed the publish and returned a media id.
 */
export async function recordTrialStep(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    organicPostId: string;
    mediaId: string;
    graduationStrategy: TrialGraduationStrategy;
  },
): Promise<string> {
  await sql`
    insert into organic_trial_reels (id, organization_id, brand_id, organic_post_id, media_id, graduation_strategy)
    values (
      ${globalThis.crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.organicPostId},
      ${input.mediaId}, ${input.graduationStrategy}
    )
    on conflict (organic_post_id) do nothing
  `;
  const rows = await sql<{ id: string }>`
    select id from organic_trial_reels where organic_post_id = ${input.organicPostId} and organization_id = ${input.organizationId} limit 1
  `;
  const trialId = rows[0]?.id;
  if (!trialId) throw new Error("The trial step could not be recorded.");
  await scheduleTrialCheck(sql, { organizationId: input.organizationId, brandId: input.brandId, trialId, checks: 0 });
  return trialId;
}

/**
 * Queues the next check, one day after it is queued. The idempotency key holds the trial and the number of checks already made, so a check is
 * queued once for each step, even when a job is retried.
 */
export async function scheduleTrialCheck(
  sql: Sql,
  input: { organizationId: string; brandId: string; trialId: string; checks: number },
): Promise<void> {
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority, run_after)
    values (
      ${globalThis.crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${TRIAL_CHECK_JOB},
      ${`trial-check:${input.trialId}:${input.checks}`}, 'queued',
      ${JSON.stringify({ organizationId: input.organizationId, trialId: input.trialId })}, 5, '', 10,
      now() + (${TRIAL_CHECK_DELAY_SECONDS}::int * interval '1 second')
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
}

/** A timestamp from the driver as ISO text, or null. A driver may return a Date or a string. */
function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

/**
 * Runs one trial check. Returns the feed status and the number of checks, which the job records as its result. A missing row, or a row that is
 * already graduated or at its check limit, is not read again.
 */
export async function runTrialCheckJob(
  sql: Sql,
  job: { organization_id: string; brand_id: string | null },
  payload: Record<string, unknown>,
  deps: TrialCheckDeps = {},
): Promise<string> {
  const trialId = typeof payload.trialId === "string" ? payload.trialId : "";
  if (!trialId) throw new Error("A trial check needs a trial reel.");
  if (!job.brand_id) throw new Error("A trial check needs a brand.");
  const brandId = job.brand_id;
  const organizationId = job.organization_id;

  const rows = await sql<{
    media_id: string;
    feed_status: TrialFeedStatus;
    feed_note: string;
    feed_observed_at: unknown;
    observed_is_shared_to_feed: boolean | null;
    checks: number;
  }>`
    select media_id, feed_status, feed_note, feed_observed_at, observed_is_shared_to_feed, checks
    from organic_trial_reels
    where id = ${trialId} and organization_id = ${organizationId} and brand_id = ${brandId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return "missing";
  if (row.feed_status === "graduated") return "graduated:no-further-checks";
  if (Number(row.checks) >= TRIAL_CHECK_MAX_CHECKS) return `${row.feed_status}:stopped-at-check-limit`;

  // The read slot is claimed before the connection is resolved, so no Instagram call is made without one. A claim that finds no slot left
  // reads nothing, and it reports the reel's state as it is now.
  const scope = { organizationId, brandId, trialId };
  const claimed = await claimTrialRead(sql, scope);
  if (claimed === null) {
    const current = await sql<{ feed_status: TrialFeedStatus }>`
      select feed_status from organic_trial_reels where id = ${trialId} and organization_id = ${organizationId} and brand_id = ${brandId} limit 1
    `;
    const status = current[0]?.feed_status ?? row.feed_status;
    return status === "graduated" ? "graduated:no-further-checks" : `${status}:stopped-at-check-limit`;
  }

  const now = deps.now ?? new Date();
  const answers = answerTracker(deps.transport ?? liveTransport());
  let reading: TrialReading;
  try {
    const connection = await resolveOrganicConnection(sql, { organizationId, brandId, platform: "instagram" }, now);
    if (connection.connected) {
      reading = await readInstagramTrial(answers.transport, { mediaId: row.media_id, accessToken: connection.accessToken });
      // A read that Instagram never answered was not made, so its slot is given back and the check is tried again by the job queue.
      if (!answers.answered()) throw new Error(reading.ok ? "Instagram did not answer the trial read." : reading.error);
    } else {
      // No account is connected, so no request is made. The check is recorded with its reason, as it always has been.
      reading = { ok: false, error: connection.reason };
    }
  } catch (error) {
    if (!answers.answered()) {
      await releaseTrialRead(sql, scope);
      const message = error instanceof Error ? error.message : "The trial read failed.";
      await sql`
        update organic_trial_reels set last_error = ${message}, updated_at = now()
        where id = ${trialId} and organization_id = ${organizationId} and brand_id = ${brandId}
      `;
    }
    throw error;
  }

  const graduation = reading.ok ? (deps.reader ?? documentedGraduationReader)(reading) : null;
  const outcome = trialCheckOutcome({
    prior: {
      feedStatus: row.feed_status,
      feedNote: row.feed_note,
      feedObservedAt: isoOrNull(row.feed_observed_at),
      observedIsSharedToFeed: row.observed_is_shared_to_feed,
      // The claim already counted this check, so the outcome sees the count before it.
      checks: claimed - 1,
    },
    reading,
    graduation,
  });

  await sql`
    update organic_trial_reels set
      feed_status = ${outcome.feedStatus},
      feed_note = ${outcome.feedNote},
      feed_observed_at = ${outcome.feedObservedAt},
      observed_is_shared_to_feed = ${outcome.observedIsSharedToFeed},
      last_error = ${outcome.lastError},
      last_checked_at = ${now.toISOString()},
      updated_at = now()
    where id = ${trialId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  if (outcome.reschedule) {
    await scheduleTrialCheck(sql, { organizationId, brandId, trialId, checks: claimed });
  }
  return `${outcome.feedStatus}:checks=${claimed}`;
}

type TrialScope = { organizationId: string; brandId: string; trialId: string };

/**
 * Claims one read of a trial reel. The count goes up by one only while it is under the limit and the reel has not graduated, and one
 * conditional update decides it: two runs that check the same reel at once cannot both take the last slot. Returns the count after the
 * claim, or null when no slot is left.
 */
async function claimTrialRead(sql: Sql, scope: TrialScope): Promise<number | null> {
  const rows = await sql<{ checks: number }>`
    update organic_trial_reels set checks = checks + 1
    where id = ${scope.trialId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
      and checks < ${TRIAL_CHECK_MAX_CHECKS} and feed_status <> 'graduated'
    returning checks
  `;
  return rows[0] ? Number(rows[0].checks) : null;
}

/** Gives back a claimed read that was never made. Only a claim whose read got no answer from Instagram is given back. */
async function releaseTrialRead(sql: Sql, scope: TrialScope): Promise<void> {
  await sql`
    update organic_trial_reels set checks = checks - 1
    where id = ${scope.trialId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and checks > 0
  `;
}

/** Wraps the transport so the check knows whether Instagram answered at all. An answer of any status is a read that was made. */
function answerTracker(transport: Transport): { transport: Transport; answered: () => boolean } {
  let answered = false;
  return {
    transport: async (request) => {
      const response = await transport(request);
      answered = true;
      return response;
    },
    answered: () => answered,
  };
}
