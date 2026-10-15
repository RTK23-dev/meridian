/**
 * Instagram trial reels (NORTH_STAR section 8, item B4), pure part. A trial reel is shared first only with non-followers. It becomes a
 * feed reel when it graduates. The publish makes the trial step, and a scheduled check records the second step.
 *
 * Documentation read 2026-10-15:
 *   trial_params: an optional parameter for media_type REELS. Its graduation_strategy is MANUAL (graduated by hand in the native app)
 *   or SS_PERFORMANCE (graduated by Instagram when it performs well). The example sends a JSON body with trial_params as a nested object.
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *     https://developers.facebook.com/docs/instagram-platform/content-publishing (Trial Reels posts)
 *   No documented field reports trial state or graduation. The IG Media node lists is_shared_to_feed, which is for Reels only and
 *   says only that a reel can appear in both the Feed and Reels tabs. Its own warning says neither value determines whether the reel
 *   actually appears in the Reels tab. A feed receipt is therefore never written from that field.
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
 *
 * This module reads and writes nothing. The Instagram calls are in instagram.ts, and the scheduled check is in trial-check.ts.
 */

/** The graduation strategies Meta documents for a trial reel. */
export const TRIAL_GRADUATION_STRATEGIES = ["MANUAL", "SS_PERFORMANCE"] as const;
export type TrialGraduationStrategy = (typeof TRIAL_GRADUATION_STRATEGIES)[number];

/** A trial step: the reel is posted as a trial, with this graduation strategy. */
export type TrialRequest = { graduationStrategy: TrialGraduationStrategy };

/** The scheduled check runs once a day, and stops after this many checks. Nothing is read or sent after the last one. */
export const TRIAL_CHECK_DELAY_SECONDS = 24 * 60 * 60;
export const TRIAL_CHECK_MAX_CHECKS = 7;

/** Why a feed step is not recorded as graduated. Meta documents no read-back of trial state, so this is the live answer. */
export const GRADUATION_NOT_DOCUMENTED =
  "The Graph API documents no field that reports trial state or graduation, and it cannot graduate a trial reel. Graduate the reel to the feed in the Instagram app.";

/**
 * Reads a trial choice from a request. Absent or null means no trial. Anything else must name a documented strategy, and a value that
 * is not one is refused with the reason, never coerced.
 */
export function parseTrialRequest(value: unknown): { ok: true; value: TrialRequest | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `The trial choice must be an object whose graduation strategy is ${TRIAL_GRADUATION_STRATEGIES.join(" or ")}.` };
  }
  const strategy = (value as { graduationStrategy?: unknown }).graduationStrategy;
  if (typeof strategy !== "string" || !(TRIAL_GRADUATION_STRATEGIES as readonly string[]).includes(strategy)) {
    return { ok: false, error: `The trial graduation must be ${TRIAL_GRADUATION_STRATEGIES.join(" or ")}.` };
  }
  return { ok: true, value: { graduationStrategy: strategy as TrialGraduationStrategy } };
}

/**
 * What one read of the reel returned. Every field is what Meta sent, or null when Meta did not send it. A read that failed carries the
 * reason, and nothing from it is read as a state.
 */
export type TrialReading =
  | { ok: true; mediaId: string; mediaProductType: string | null; isSharedToFeed: boolean | null; permalink: string | null }
  | { ok: false; error: string };

/** The graduation question, answered from a reading. A graduation is recorded only when `graduated` is true. */
export type GraduationReading = { graduated: true; observedAt: string } | { graduated: null; reason: string };

export type GraduationReader = (reading: Extract<TrialReading, { ok: true }>) => GraduationReading;

/** The live reader. Meta documents no field that reports graduation, so nothing is read as graduated. */
export const documentedGraduationReader: GraduationReader = () => ({ graduated: null, reason: GRADUATION_NOT_DOCUMENTED });

export type TrialFeedStatus = "waiting" | "manual_action_required" | "graduated";

/** The stored state of a trial before a check. */
export type PriorTrialState = {
  feedStatus: TrialFeedStatus;
  feedNote: string;
  feedObservedAt: string | null;
  observedIsSharedToFeed: boolean | null;
  checks: number;
};

export type TrialCheckOutcome = {
  feedStatus: TrialFeedStatus;
  feedNote: string;
  feedObservedAt: string | null;
  observedIsSharedToFeed: boolean | null;
  lastError: string;
  /** True when another check should be scheduled: the reel has not graduated and the check limit is not reached. */
  reschedule: boolean;
};

/**
 * The state a check leaves behind. A failed read keeps the prior feed state and records the reason. A successful read with a graduation
 * observed records the feed step as graduated, with the time it was observed. A successful read with no graduation observed records that
 * the person must graduate the reel, with the reason. The graduation is never inferred from is_shared_to_feed.
 */
export function trialCheckOutcome(input: {
  prior: PriorTrialState;
  reading: TrialReading;
  graduation: GraduationReading | null;
}): TrialCheckOutcome {
  const checksAfter = input.prior.checks + 1;
  const withinLimit = checksAfter < TRIAL_CHECK_MAX_CHECKS;
  if (!input.reading.ok) {
    return {
      feedStatus: input.prior.feedStatus,
      feedNote: input.prior.feedNote,
      feedObservedAt: input.prior.feedObservedAt,
      observedIsSharedToFeed: input.prior.observedIsSharedToFeed,
      lastError: input.reading.error,
      reschedule: withinLimit,
    };
  }
  const isSharedToFeed = input.reading.isSharedToFeed;
  const graduation = input.graduation;
  if (graduation && graduation.graduated === true) {
    return {
      feedStatus: "graduated",
      feedNote: `Graduation observed at ${graduation.observedAt}.`,
      feedObservedAt: graduation.observedAt,
      observedIsSharedToFeed: isSharedToFeed,
      lastError: "",
      reschedule: false,
    };
  }
  return {
    feedStatus: "manual_action_required",
    feedNote: graduation && graduation.graduated === null ? graduation.reason : GRADUATION_NOT_DOCUMENTED,
    feedObservedAt: null,
    observedIsSharedToFeed: isSharedToFeed,
    lastError: "",
    reschedule: withinLimit,
  };
}
