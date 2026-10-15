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
  const checks = Number(row.checks);
  if (row.feed_status === "graduated") return "graduated:no-further-checks";
  if (checks >= TRIAL_CHECK_MAX_CHECKS) return `${row.feed_status}:stopped-at-check-limit`;

  const now = deps.now ?? new Date();
  const connection = await resolveOrganicConnection(sql, { organizationId, brandId, platform: "instagram" }, now);
  const reading: TrialReading = connection.connected
    ? await readInstagramTrial(deps.transport ?? liveTransport(), { mediaId: row.media_id, accessToken: connection.accessToken })
    : { ok: false, error: connection.reason };
  const graduation = reading.ok ? (deps.reader ?? documentedGraduationReader)(reading) : null;
  const outcome = trialCheckOutcome({
    prior: {
      feedStatus: row.feed_status,
      feedNote: row.feed_note,
      feedObservedAt: isoOrNull(row.feed_observed_at),
      observedIsSharedToFeed: row.observed_is_shared_to_feed,
      checks,
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
      checks = checks + 1,
      last_checked_at = ${now.toISOString()},
      updated_at = now()
    where id = ${trialId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  if (outcome.reschedule) {
    await scheduleTrialCheck(sql, { organizationId, brandId, trialId, checks: checks + 1 });
  }
  return `${outcome.feedStatus}:checks=${checks + 1}`;
}
