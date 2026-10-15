// PROPOSED operations thresholds (Video Engine Bible 14.4, 15.3, 10.4, 19 E6). These are not in config/thresholds.ts: the lead
// decided not to let this branch edit config, so the numbers live here, typed and versioned, with the source of each one. The lead
// moves them into config/thresholds.ts (as Tunable where a floor and ceiling are proposed) when accepted. Every value marked
// "Bible" is given by the Bible; every value marked "proposed" is an initial guess to be measured in E6 and is listed in STATUS.md.
//
// The concurrency bounds are not in config at all (thresholds.router.concurrency is three plain numbers). They are proposed here.

import { thresholds } from "../config/thresholds.ts";

export const OPS_PROPOSAL_VERSION = "ops-proposed@1" as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The shape every operations function reads. Tests pass their own values of this shape; production passes the proposal. */
export type OpsThresholds = {
  version: string;
  budget: { reservationOverrunShare: number; formatOverEstimateShare: number; formatWindowMs: number; formatMinRequests: number };
  deadLetter: { openMinutes: number; growthWindowMinutes: number; growthMinNew: number };
  breaker: { alertWhenOpen: boolean };
  stuck: { noLiveJobMinutes: number };
  gatePass: { dropPoints: number; recentWindowMinutes: number; baselineWindowMinutes: number; minEvaluations: number };
  concurrency: {
    windowMs: number;
    rateLimitShareMax: number;
    shrinkFactor: number;
    growShare: number;
    saturationMin: number;
    latencyRisingRatio: number;
    minAttempts: number;
    bounds: Record<"video" | "image" | "tts", { floor: number; ceiling: number }>;
  };
};

export const proposedOpsThresholds: OpsThresholds = {
  version: OPS_PROPOSAL_VERSION,

  budget: {
    /** Bible 14.1: cap mode refuses a call beyond its reservation, so any settled spend over the ceiling is a defect. Hard limit. */
    reservationOverrunShare: 0,
    /** Bible 14.4: alert when a format's average real cost exceeds its estimate by over 20% for a day. */
    formatOverEstimateShare: 0.2,
    /** Bible 14.4: "for a day". */
    formatWindowMs: 24 * HOUR_MS,
    /** proposed: a format average over fewer delivered requests than this is noise, not an alert. */
    formatMinRequests: 5,
  },

  deadLetter: {
    /** Bible 15.3: "dead-letter queue above zero for 15 minutes". An open dead letter older than this pages. */
    openMinutes: 15,
    /** proposed: dead engine jobs created in the growth window at or above this count raise a growth alert. */
    growthWindowMinutes: 60,
    growthMinNew: 5,
  },

  breaker: {
    /** Bible 15.3: "any provider circuit open". An open breaker always alerts. */
    alertWhenOpen: true,
  },

  stuck: {
    /** proposed: a running request with no queued, running or retrying engine job for this long is stuck. */
    noLiveJobMinutes: 30,
  },

  gatePass: {
    /** Bible 15.3: "gate pass rate dropping 20 points in an hour". Share of points, so 0.2 is 20 points. */
    dropPoints: 0.2,
    /** Bible 15.3: the recent window is one hour. */
    recentWindowMinutes: 60,
    /** proposed: the baseline window before the recent one, in which the rate is measured. */
    baselineWindowMinutes: 24 * 60,
    /** proposed: a gate needs this many evaluations in each window before its rate is compared. */
    minEvaluations: 10,
  },

  concurrency: {
    /** proposed: the observation window for sizing. */
    windowMs: HOUR_MS,
    /** Bible 10.4 gives the breaker's failure share; this proposed share is for 429s only. */
    rateLimitShareMax: 0.05,
    /** proposed: a bucket is shrunk by this factor when its 429 share is over the limit. */
    shrinkFactor: 0.75,
    /** proposed: a bucket grows by this share of its size (at least one slot) only with measured headroom and no 429s. */
    growShare: 0.1,
    /** proposed: the share of sampled moments a bucket was full (in-flight at its limit) before growth is considered. */
    saturationMin: 0.5,
    /** proposed: a median latency in the later half of the window this many times the earlier half holds growth. */
    latencyRisingRatio: 1.5,
    /** proposed: minimum provider-side attempts in the window for any sizing decision (the Bible gives no number; the router's own
     * minAttempts is used so both agree). */
    minAttempts: thresholds.router.minAttempts.value,
    /** proposed bounds per bucket class, the floor and ceiling a proposal is held inside. */
    bounds: {
      video: { floor: 2, ceiling: 20 },
      image: { floor: 4, ceiling: 40 },
      tts: { floor: 4, ceiling: 60 },
    },
  },
};
