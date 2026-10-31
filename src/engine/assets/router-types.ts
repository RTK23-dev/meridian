// The asset router's types, settings and constants: the inputs and outcomes of produce, the router's dependencies, and the
// shapes of one target's submit. Moved out of engine/assets/router.ts unchanged (coding loop, T9a). router.ts re-exports the
// public names.

import { adapters } from "../config/adapters.ts";
import type { AssetSpec, ProviderError, ProviderPoll } from "../contracts/assets.ts";
import type { Decision } from "../contracts/plan.ts";
import type { ModelClass } from "../contracts/plan.ts";
import { thresholds } from "../config/thresholds.ts";
import type { BudgetAlert } from "../budget/reserve.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import type { MediaDownloader } from "../gateway/download.ts";
import type { LockableLedger } from "../gateway/paid.ts";
import type { MediaStore, RoutedAdapter } from "./adapter.ts";
import type { ProviderErrorKind } from "./classify.ts";
import type { AssetCache } from "./cache.ts";
import type { ProviderStats, AttemptOutcome } from "./stats.ts";
import type { BreakerSettings, BreakerStore } from "./breaker.ts";
import type { BucketStore, BucketClass } from "./buckets.ts";
import { configuredWeights, type DimensionWeights } from "./score.ts";
import type { VideoProfile } from "./providers/openrouterVideo.ts";
import type { ModelCatalogSource } from "../gateway/catalog.ts";
import type { AssetJob, SettlementStore } from "./job.ts";

/** The router's timing values, read from config/adapters.ts (adapters@1). */
export const ROUTER_CONSTANTS = {
  pollIntervalMs: adapters.polling.intervalMs.value,
  backoffBaseMs: adapters.retry.backoffBaseMs.value,
  backoffCapMs: adapters.retry.backoffCapMs.value,
  reliabilityWindowMs: adapters.reliabilityWindowMs,
} as const;

export type RouterSettings = {
  /** Submits per target for retryable errors, including the first. */
  maxAttempts: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  breaker: BreakerSettings;
  concurrency: Record<BucketClass, number>;
  reliabilityWindowMs: number;
  weights: DimensionWeights;
};

/** The defaults, read from config/thresholds.ts and config/weights.ts. */

export function defaultRouterSettings(): RouterSettings {
  return {
    maxAttempts: thresholds.jobs.maxAttempts,
    pollTimeoutMs: thresholds.jobs.leaseMs.generation,
    pollIntervalMs: ROUTER_CONSTANTS.pollIntervalMs,
    backoffBaseMs: ROUTER_CONSTANTS.backoffBaseMs,
    backoffCapMs: ROUTER_CONSTANTS.backoffCapMs,
    breaker: {
      failureShare: thresholds.router.breaker.failureShare,
      windowMs: thresholds.router.breaker.windowMs,
      skipMs: thresholds.router.breaker.skipMs,
      minSample: thresholds.router.breaker.minSample.value,
    },
    concurrency: { video: thresholds.router.concurrency.video, image: thresholds.router.concurrency.image, tts: thresholds.router.concurrency.tts },
    reliabilityWindowMs: ROUTER_CONSTANTS.reliabilityWindowMs,
    weights: configuredWeights(),
  };
}

/** Learned inputs for task fit and output quality. Null means unknown, which the score leaves out. */

export interface RouterSignals {
  /** Gold-set score of the route's model, 0 to 1, or null (Bible 10.2, refreshed weekly). */
  qualityScore(route: ResolvedRoute): number | null;
  /** Learned pass rate of the route's model for a visual type, 0 to 1, or null (Bible 10.2 task fit). */
  passRate(route: ResolvedRoute, visualType: string | undefined): number | null;
}

export const NO_SIGNALS: RouterSignals = {
  qualityScore: () => null,
  passRate: () => null,
};

export type RouterDeps = {
  gateway: Gateway;
  /** The ledger. It offers withLock when the store can run a budget step under a row lock (gateway/paid.ts). */
  ledger: LockableLedger;
  cache: AssetCache;
  stats: ProviderStats;
  breakers: BreakerStore;
  buckets: BucketStore;
  media: MediaStore;
  /**
   * Where settled results are recorded, by submit, so that a job settled twice changes nothing. Memory by default. Production
   * passes a durable store: a settle that is not recorded is run again.
   */
  settlements?: SettlementStore<StepReport>;
  /**
   * When set, settle downloads a finished video through the gateway (gateway/download.ts), checks it is an mp4 within the size
   * limit, and stores the bytes through `media`: the asset's uri is then the stored copy. When unset, settle returns the provider's
   * own uri, as produce always has, and the take stage downloads it.
   */
  takes?: { downloader?: MediaDownloader };
  /** Verified video profiles from GET /videos/models. Empty means no video model is connected. */
  videoProfiles?: ReadonlyMap<string, VideoProfile>;
  /**
   * OpenRouter's model catalog (gateway/catalog.ts, Bible 10.5). Read only for a spec that carries a modelChoice: the chosen model is
   * checked against it again, and its price is the estimate. Absent, a spec with a choice is routed by the route table, with a
   * decision that says so.
   */
  catalog?: ModelCatalogSource;
  signals?: RouterSignals;
  settings?: Partial<RouterSettings>;
  /** Epoch milliseconds. Injected so that tests control time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ProduceInput = {
  spec: AssetSpec;
  workspaceId: string;
  requestId: string;
  /** The reservation the paid calls are authorized against. Must exist before any paid call. */
  reservationId: string;
  /** The budget stage name, for example "produce_shot". */
  stage: string;
  visualType?: string;
  /** The provider the scene's earlier shots used, for the continuity dimension. */
  continuityProvider?: string | null;
  /** The page's voice id, for speech routes. */
  voiceId?: string | null;
  /** The provider the page's voice belongs to (the voice kit's provider). A speech model of another vendor is not used for the page. */
  voiceProvider?: string | null;
  /** The speaking rate for speech routes (1 is the vendor's default). Part of the adapter's identity, so it is part of the cache key. */
  speechSpeed?: number;
};

export type ProducedAsset = {
  /** The adapter id: provider and model. */
  providerId: string;
  modelClass: ModelClass;
  uri: string;
  cacheKey: string;
  /** What the asset cost: the provider bills of the submits of its winning target. Zero for a cache hit. Never an estimate (contract v6). */
  costUsd: number;
  cacheHit: boolean;
  /** On a cache hit, the cost the hit saved. */
  savedUsd: number;
  ledgerEntryId: string | null;
  generationId: string | null;
  mediaType: string | null;
  /** Submits made on the winning target (0 on a cache hit). */
  submits: number;
};

export type AttemptLog = {
  providerId: string;
  attempt: number;
  atMs: number;
  outcome: AttemptOutcome;
  errorKind: ProviderErrorKind | null;
  latencyMs: number | null;
};

export type ProduceOutcome =
  | { status: "done"; asset: ProducedAsset }
  /** A content or input refusal. The planner rewrites the prompt once, then downgrades the shot (Bible 10.4). */
  | { status: "failed"; providerId: string; error: ProviderError }
  /** No eligible target is connected. Nothing was sent. */
  | { status: "not_connected"; reasons: string[] }
  /** Every target the budget could take was refused. Nothing was sent. */
  | { status: "refused"; reasons: string[] }
  /** A concurrency bucket is full. The job stays queued; it does not spin. */
  | { status: "queued"; reasons: string[] }
  /** The same call was already authorized. Nothing was sent again. */
  | { status: "duplicate"; providerId: string; ledgerEntryId: string }
  /** No target produced an asset. */
  | { status: "unavailable"; reasons: string[] }
  /**
   * A paid submit has an unknown outcome: a server error, a timeout, or an answer with no job id, so the provider may have billed it.
   * Nothing else is submitted for the asset, on this target or any other, until the submit is settled from its invoice or confirmed
   * absent by the provider (resolveAmbiguousSubmit). The stage stops with this reason.
   */
  | { status: "unsettled"; providerId: string; idempotencyKey: string; ledgerEntryId: string; reason: string };

export type ProduceReport = {
  outcome: ProduceOutcome;
  decisions: Decision[];
  alerts: BudgetAlert[];
  attempts: AttemptLog[];
};

export interface AssetRouter {
  produce(input: ProduceInput): Promise<ProduceReport>;
}

/** What one step of the asynchronous path did. `submitted` names the job the poller must poll; the rest is terminal. */

export type AssetStep =
  | { status: "submitted"; job: AssetJob; runAfterMs: number }
  | ProduceOutcome;

export type StepReport = {
  step: AssetStep;
  decisions: Decision[];
  alerts: BudgetAlert[];
  attempts: AttemptLog[];
};

/** The router with its asynchronous entry points. produce is the submit and poll loop over these two. */

export interface AsyncAssetRouter extends AssetRouter {
  submit(input: ProduceInput): Promise<StepReport>;
  /** One poll of a submitted job, without waiting. A pending answer means poll again later; a finished one goes to settle. */
  pollOnce(job: AssetJob, input: ProduceInput): Promise<ProviderPoll>;
  settle(job: AssetJob, polled: ProviderPoll, input: ProduceInput): Promise<StepReport>;
}

export type Candidate = {
  priority: number;
  route: ResolvedRoute;
  adapter: RoutedAdapter;
  estimateUsd: number;
  cacheKey: string;
};

/** The attempt state of the target being submitted, carried in the job and updated as the target's submits are made. */

export type TargetState = {
  submitNumber: number;
  targetBilledUsd: number;
  targetSubmits: number;
  targetFirstEntryId: string | null;
};

export type JobBody = Omit<AssetJob, "carry">;

export type TargetResult =
  | { kind: "submitted"; job: JobBody }
  | { kind: "refused"; reason: string }
  | { kind: "duplicate"; providerId: string; ledgerEntryId: string }
  | { kind: "queued"; reason: string }
  | { kind: "planner"; providerId: string; error: ProviderError }
  | { kind: "exhausted"; providerId: string; reason: string }
  | { kind: "unsettled"; providerId: string; idempotencyKey: string; ledgerEntryId: string; reason: string };

/** The target that failed and the reason, so that the next target's decision can name it (Bible 10.4). */

export type Fallback = { providerId: string; reason: string } | null;

/** Whether a spec asks for something the adapter's capabilities cannot give. Returns the reason, or null when it fits. */
