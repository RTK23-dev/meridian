// The asset router (Bible 10.2 and 10.4). It takes one AssetSpec, lists the routed targets of its model class from the gateway
// (config/routes.ts), filters them, scores them, serves a cache hit at $0, and otherwise makes the submit to the first target that is
// free to run. Three entry points share one state machine:
//
//   submit(input)           chooses a target, authorizes its submit on the ledger, sends it, and returns an AssetJob (the
//                           provider's job id, the submit's ledger key and the attempt state). The job holds a concurrency slot.
//   settle(job, poll, in)   finishes one submit when its poll is finished: reconciles its bill, records stats, and returns the
//                           asset (done), the planner's refusal (failed), or the next submit (submitted: a retry on the same
//                           target, or the next target). Settling a job twice returns the first result and changes nothing.
//   produce(input)          submit, then poll until each job is finished and settle it, for synchronous callers and tests.
//
// Retries and ambiguity (Bible 10.4, contract v6). A refusal the provider gave before any job id existed (rate_limit, invalid_input,
// content_policy) creates no job: it is settled as absent, and only a rate_limit retries on the same target, with backoff, up to
// thresholds.jobs.maxAttempts submits in total. content_policy and invalid_input return `failed` for the planner and never fall back.
// Every other submit failure (server, timeout, unknown, or an answer with no job id) is AMBIGUOUS: the provider may have accepted and
// billed a job, so the submit stays unsettled and the asset returns `unsettled`. Nothing else is submitted for the asset, on this target
// or another, until an operator settles the submit (resolveAmbiguousSubmit).
//
// Ledger (Bible 14.1, contract v6). Every submit is authorized before it is sent, under its own key: the first submit of a target uses
// the target's cache key, and a retry uses that key with an attempt suffix. A submit is settled only to the provider's verified bill, or
// as absent when the provider refused it before any job existed. With no bill the submit stays held at its reservation and its cost is
// unknown: no list price is booked. The asset's cost is the sum of the bills over the submits of its winning target. The provider's own
// id for the call (the generation id an adapter reports, contract v9) is recorded on its entry whether or not the bill arrives, so the
// reconciler can read a held bill later (budget/reconcile-holds.ts).
//
// The router never sends a request itself: every call is an adapter's, and every adapter calls only the gateway.

import { adapters } from "../config/adapters.ts";
import { EngineError } from "../contracts/errors.ts";
import { providerErrorSchema, type AssetSpec, type ProviderError, type ProviderPoll } from "../contracts/assets.ts";
import { contentHash } from "../contracts/hash.ts";
import { sumUsd } from "../contracts/money.ts";
import type { Decision } from "../contracts/plan.ts";
import type { ModelClass } from "../contracts/plan.ts";
import { thresholds } from "../config/thresholds.ts";
import type { BudgetAlert } from "../budget/reserve.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import { isDisabledModel } from "../config/model-policy.ts";
import { gatewayDownloader, type MediaDownloader } from "../gateway/download.ts";
import type { LockableLedger } from "../gateway/paid.ts";
import { type MediaStore, type RoutedAdapter } from "./adapter.ts";
import { classifyError, excerpt, type ProviderErrorKind } from "./classify.ts";
import { type AssetCache, type CachedAsset, routeCacheKey } from "./cache.ts";
import { type ProviderStats, type AttemptOutcome, type AttemptRecord, medianLatencyMs, successRate } from "./stats.ts";
import { type BreakerSettings, type BreakerStore, evaluateBreaker, openBreaker } from "./breaker.ts";
import { type BucketStore, bucketClassFor, type BucketClass } from "./buckets.ts";
import {
  compareScored,
  configuredWeights,
  continuityValue,
  controlValue,
  costEfficiencyValues,
  latencyValues,
  scoreProvider,
  type DimensionValues,
  type DimensionWeights,
  type ScoreResult,
} from "./score.ts";
import { adapterFor as buildAdapter, type AdapterContext } from "./providers/index.ts";
import { isVideoClass, videoProfilesFromListing, type VideoProfile } from "./providers/openrouterVideo.ts";
import type { ModelCatalog, ModelCatalogSource } from "../gateway/catalog.ts";
import { rejectionOf } from "../gateway/catalog-fit.ts";
import type { ModelCatalogEntry } from "../contracts/catalog.ts";
import { catalogEstimateUsd, needOf } from "./model-choice.ts";
import { authorizeSubmit, confirmAbsentSubmit, reconcileSubmit } from "./ledger-steps.ts";
import {
  ASSET_JOB_SCHEMA,
  CARRY_LIMIT,
  capped,
  memorySettlementStore,
  parseAssetJob,
  type AssetJob,
  type AssetJobCarry,
  type AssetTarget,
  type SettlementStore,
} from "./job.ts";
import { normaliseUri, normaliseVideo, OUTPUT_LIMITS, VIDEO_MEDIA_TYPE } from "./normalise.ts";

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
  /**
   * The model families this router must not submit to: the workspace's switched-off families, with a plan's brand families added (D16).
   * A route-table target, the route table being the fallback when a chosen model is not used, of one of them is excluded with that reason,
   * before any adapter is built, so no fallback can reach it. Absent: no family is excluded here. A poll or a settle is never refused by it.
   */
  disabledFamilies?: readonly string[];
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

type Candidate = {
  priority: number;
  route: ResolvedRoute;
  adapter: RoutedAdapter;
  estimateUsd: number;
  cacheKey: string;
};

/** The attempt state of the target being submitted, carried in the job and updated as the target's submits are made. */
type TargetState = {
  submitNumber: number;
  targetBilledUsd: number;
  targetSubmits: number;
  targetFirstEntryId: string | null;
};

type JobBody = Omit<AssetJob, "carry">;

type TargetResult =
  | { kind: "submitted"; job: JobBody }
  | { kind: "refused"; reason: string }
  | { kind: "duplicate"; providerId: string; ledgerEntryId: string }
  | { kind: "queued"; reason: string }
  | { kind: "planner"; providerId: string; error: ProviderError }
  | { kind: "exhausted"; providerId: string; reason: string }
  | { kind: "unsettled"; providerId: string; idempotencyKey: string; ledgerEntryId: string; reason: string };

/** The target that failed and the reason, so that the next target's decision can name it (Bible 10.4). */
type Fallback = { providerId: string; reason: string } | null;

/** Whether a spec asks for something the adapter's capabilities cannot give. Returns the reason, or null when it fits. */
export function capabilityGap(spec: AssetSpec, caps: { maxSeconds: number; minSeconds: number; firstFrame: boolean; lastFrame: boolean; refsMax: number; aspect: string[] }): string | null {
  const timed = spec.modelClass.startsWith("video.") || spec.modelClass === "avatar" || spec.modelClass === "lipsync";
  if (timed) {
    const seconds = spec.durationMs / 1000;
    if (caps.maxSeconds <= 0) return "capabilities not verified";
    if (seconds < caps.minSeconds || seconds > caps.maxSeconds) return `duration ${seconds} s is outside ${caps.minSeconds} to ${caps.maxSeconds} s`;
    if (!caps.aspect.includes(spec.aspect)) return `aspect ${spec.aspect} is not supported`;
  }
  if (spec.firstFrame !== undefined && !caps.firstFrame) return "no first-frame support";
  if (spec.lastFrame !== undefined && !caps.lastFrame) return "no last-frame support";
  if (spec.refs.length > caps.refsMax) return `takes ${spec.refs.length} references, the adapter accepts ${caps.refsMax}`;
  return null;
}

/**
 * A refusal the provider gave before any job id existed: no job was created, so the submit is settled as absent and nothing is billed
 * by it (contract v6). Every other failure of a submit (a server error, a timeout, an answer with no job id) is ambiguous: the provider
 * may have accepted and billed a job, so it is left unsettled and never resubmitted.
 */
const DEFINITIVE_REFUSALS: ReadonlySet<ProviderError["kind"]> = new Set(["rate_limit", "invalid_input", "content_policy"]);

function isDefinitiveRefusal(error: ProviderError): boolean {
  return DEFINITIVE_REFUSALS.has(error.kind);
}

/** A definitive rate limit is retried with a new attempt key, because the refused submit is settled as absent first. */
function shouldRetry(error: ProviderError): boolean {
  return error.kind === "rate_limit";
}

function outcomeFor(error: ProviderError | null): AttemptOutcome {
  if (error === null) return "success";
  return error.kind === "content_policy" || error.kind === "invalid_input" ? "request_refused" : "provider_failure";
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushCapped(list: string[], item: string): void {
  if (list.length < CARRY_LIMIT) list.push(item);
}

function emptyCarry(): AssetJobCarry {
  return { excluded: [], exhausted: [], refused: [], queued: [], duplicate: null };
}

/** Records what a non-submitted target result leaves behind, and returns the fallback it names (if it failed). */
function absorb(carry: AssetJobCarry, result: Exclude<TargetResult, { kind: "submitted" } | { kind: "planner" } | { kind: "unsettled" }>): Fallback {
  switch (result.kind) {
    case "duplicate":
      carry.duplicate = { providerId: result.providerId, ledgerEntryId: result.ledgerEntryId };
      return null;
    case "refused":
      pushCapped(carry.refused, result.reason);
      return null;
    case "queued":
      pushCapped(carry.queued, result.reason);
      return null;
    case "exhausted":
      pushCapped(carry.exhausted, result.reason);
      return { providerId: result.providerId, reason: result.reason };
  }
}

/** The final outcome of an asset whose targets have all been tried, from what was carried (the order is the one produce always used). */
function finalOutcome(carry: AssetJobCarry): ProduceOutcome {
  if (carry.queued.length > 0) return { status: "queued", reasons: [...carry.queued, ...carry.exhausted] };
  if (carry.duplicate !== null) return { status: "duplicate", providerId: carry.duplicate.providerId, ledgerEntryId: carry.duplicate.ledgerEntryId };
  if (carry.refused.length > 0 && carry.exhausted.length === 0) return { status: "refused", reasons: carry.refused };
  return { status: "unavailable", reasons: [...carry.exhausted, ...carry.refused, ...carry.excluded] };
}

/** Releases a concurrency slot once. A slot is held by one job at a time; the holder clears its own reference before handing it on. */
async function freeSlot(slot: { bucketId: string | null }, buckets: BucketStore): Promise<void> {
  const id = slot.bucketId;
  if (id === null) return;
  slot.bucketId = null;
  await buckets.release(id);
}

export function createAssetRouter(deps: RouterDeps): AsyncAssetRouter {
  const settings: RouterSettings = { ...defaultRouterSettings(), ...deps.settings };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepFor;
  const signals = deps.signals ?? NO_SIGNALS;
  const videoProfiles = deps.videoProfiles ?? new Map<string, VideoProfile>();
  const settlements: SettlementStore<StepReport> = deps.settlements ?? memorySettlementStore<StepReport>();
  const takeDownloader: MediaDownloader | null = deps.takes ? (deps.takes.downloader ?? gatewayDownloader(deps.gateway)) : null;
  const adapterCache = new Map<string, RoutedAdapter>();
  const at = (): string => new Date(now()).toISOString();
  const limitFor = (modelClass: ModelClass): number => settings.concurrency[bucketClassFor(modelClass)];
  const backoffFor = (attempt: number): number => Math.min(settings.backoffCapMs, settings.backoffBaseMs * 2 ** (attempt - 1));

  function contextFor(
    workspaceId: string,
    voiceId: string | null | undefined,
    speechSpeed: number | undefined,
    profiles: ReadonlyMap<string, VideoProfile>,
    voiceProvider: string | null | undefined,
  ): AdapterContext {
    return {
      gateway: deps.gateway,
      organizationId: workspaceId,
      workspaceId,
      media: deps.media,
      videoProfiles: profiles,
      voice: voiceId ?? null,
      voiceProvider: voiceProvider ?? null,
      speechSpeed: speechSpeed ?? 1,
    };
  }

  /**
   * The adapter for a route, built once per capability, route, workspace, voice and (for video) profile. Keeping the instance matters
   * for adapters that keep a job's result in process (speech): the poll must reach the instance that submitted the job. `profiles`
   * replaces the router's video profiles for a model chosen from the catalog (Bible 10.5), whose profile comes from the same read.
   */
  function adapterFor(
    route: ResolvedRoute,
    workspaceId: string,
    voiceId: string | null | undefined,
    speechSpeed?: number,
    profiles: ReadonlyMap<string, VideoProfile> = videoProfiles,
    voiceProvider?: string | null,
  ): RoutedAdapter | null {
    const profile = isVideoClass(route.capability) ? (profiles.get(route.model) ?? null) : null;
    const key = `${route.capability}\u0000${route.provider.id}:${route.model}\u0000${workspaceId}\u0000${voiceId ?? ""}\u0000${voiceProvider ?? ""}\u0000${speechSpeed ?? 1}\u0000${profile === null ? "" : JSON.stringify(profile)}`;
    const cached = adapterCache.get(key);
    if (cached) return cached;
    const adapter = buildAdapter(route, contextFor(workspaceId, voiceId, speechSpeed, profiles, voiceProvider));
    if (adapter !== null) adapterCache.set(key, adapter);
    return adapter;
  }

  /** A route to an OpenRouter model the orchestrator chose (Bible 10.5). It has no price key: its price is the catalog's. */
  function chosenRouteOf(modelClass: ModelClass, modelId: string): ResolvedRoute {
    return { capability: modelClass, provider: deps.gateway.provider("openrouter"), model: modelId, priceKey: null, verified: false };
  }

  /** The adapter of a job's target, looked up again so that a route that has changed since the submit fails closed. */
  function adapterForTarget(target: AssetTarget, modelClass: ModelClass, input: ProduceInput): RoutedAdapter {
    const choice = input.spec.modelChoice;
    const chosen = choice !== null && target.provider === choice.provider && target.model === choice.modelId;
    const route = chosen
      ? chosenRouteOf(modelClass, target.model)
      : deps.gateway.routes(modelClass).find((candidate) => candidate.provider.id === target.provider && candidate.model === target.model);
    if (route === undefined) {
      throw new EngineError("config", `${target.adapterId} is no longer routed for ${modelClass}; the job cannot be settled`, { stage: input.stage });
    }
    // A chosen video model's profile comes from the catalog read its submit was checked against (kept in chosenProfiles). In a process
    // that has not read it, the profile is unknown, which a poll does not need; a submit then refuses before any request.
    const adapter = chosen
      ? adapterFor(route, input.workspaceId, input.voiceId, input.speechSpeed, withChosenProfiles(), input.voiceProvider)
      : adapterFor(route, input.workspaceId, input.voiceId, input.speechSpeed, videoProfiles, input.voiceProvider);
    if (adapter === null || adapter.id !== target.adapterId) {
      throw new EngineError("config", `${target.adapterId} has no adapter in this runtime`, { stage: input.stage });
    }
    return adapter;
  }

  function report(session: Session, step: AssetStep): StepReport {
    return { step, decisions: session.decisions, alerts: session.alerts, attempts: session.attempts };
  }

  async function recordAttempt(session: Session, providerId: string, startedMs: number, error: ProviderError | null, latencyMs: number | null, attempt: number): Promise<void> {
    const outcome = outcomeFor(error);
    const errorKind = error === null ? null : error.kind;
    session.attempts.push({ providerId, attempt, atMs: startedMs, outcome, errorKind, latencyMs });
    await deps.stats.record({ providerId, atMs: startedMs, outcome, latencyMs, errorKind });
    await evaluateBreaker(deps.stats, deps.breakers, providerId, now(), settings.breaker);
  }

  /**
   * Makes the submits of one target: its first, and its retries on a retryable failure (Bible 10.4). Each submit is authorized on the
   * ledger before it is sent. A submit that fails is held at its estimate. The slot is the caller's when `slotHeld`, and otherwise is
   * acquired here; it is released on every outcome except a submitted job, which takes it over.
   */
  async function driveTarget(
    session: Session,
    input: ProduceInput,
    targets: readonly AssetTarget[],
    index: number,
    state: TargetState,
    options: { startAttempt: number; slotHeld: boolean },
  ): Promise<TargetResult> {
    const target = targets[index] as AssetTarget;
    const { spec } = input;
    if (!options.slotHeld && !(await deps.buckets.tryAcquire(target.adapterId, limitFor(spec.modelClass)))) {
      return { kind: "queued", reason: `${target.adapterId}: concurrency bucket full (${limitFor(spec.modelClass)})` };
    }
    let handedOver = false;
    try {
      const adapter = adapterForTarget(target, spec.modelClass, input);
      for (let attempt = options.startAttempt; ; attempt += 1) {
        const key = attempt === 1 ? target.cacheKey : `${target.cacheKey}|attempt${attempt}`;
        const authorized = await authorizeSubmit(deps.ledger, {
          reservationId: input.reservationId,
          stage: input.stage,
          provider: target.provider,
          model: target.model,
          estimateUsd: target.estimateUsd,
          idempotencyKey: key,
          at: at(),
        });
        if (authorized.status === "refused") {
          session.alerts.push(...authorized.alerts);
          return { kind: "refused", reason: `${target.adapterId}: ${authorized.reason}` };
        }
        if (authorized.status === "duplicate") {
          // A key already on the ledger that is still unsettled may have been billed. Nothing else is submitted for the asset then.
          if (authorized.entry.settlement === undefined) {
            return {
              kind: "unsettled",
              providerId: target.adapterId,
              idempotencyKey: authorized.entry.idempotencyKey,
              ledgerEntryId: authorized.entry.entryId,
              reason: `${target.adapterId}: a submit under ${authorized.entry.idempotencyKey} is unsettled and may have been billed`,
            };
          }
          return { kind: "duplicate", providerId: target.adapterId, ledgerEntryId: authorized.entry.entryId };
        }
        session.alerts.push(...authorized.alerts);
        if (state.targetFirstEntryId === null) state.targetFirstEntryId = authorized.entry.entryId;
        state.submitNumber += 1;
        state.targetSubmits += 1;

        const startedMs = now();
        let answer: { jobRef: string } | null = null;
        let error: ProviderError | null = null;
        try {
          answer = await adapter.submit(spec, key);
        } catch (thrown) {
          error = classifyError(thrown);
        }
        if (answer !== null && answer.jobRef.length > 0 && answer.jobRef.length <= 512) {
          // The job is checked before the slot is handed over. An invariant that fails here is an error, not a refusal.
          const job: JobBody = {
            schema: ASSET_JOB_SCHEMA,
            jobRef: answer.jobRef,
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            reservationId: input.reservationId,
            stage: input.stage,
            modelClass: spec.modelClass,
            providerId: target.adapterId,
            provider: target.provider,
            model: target.model,
            idempotencyKey: key,
            attemptOnTarget: attempt,
            submitNumber: state.submitNumber,
            submittedAt: new Date(startedMs).toISOString(),
            targets: [...targets],
            targetIndex: index,
            targetBilledUsd: state.targetBilledUsd,
            targetSubmits: state.targetSubmits,
            targetFirstEntryId: state.targetFirstEntryId,
          };
          parseAssetJob({ ...job, carry: emptyCarry() });
          handedOver = true;
          return { kind: "submitted", job };
        }
        error ??= { kind: "unknown", retryable: false, message: "the provider returned no usable job id" };

        await recordAttempt(session, target.adapterId, startedMs, error, null, attempt);
        if (!isDefinitiveRefusal(error)) {
          // The submit may have been accepted and billed, and nothing says which. Its hold stands, unsettled: no estimate is booked, and
          // nothing else is submitted for this asset, on this target or another, until the submit is settled (resolveAmbiguousSubmit).
          return {
            kind: "unsettled",
            providerId: target.adapterId,
            idempotencyKey: key,
            ledgerEntryId: authorized.entry.entryId,
            reason: `${target.adapterId}: ${error.kind}: ${error.message}; the submit may have been billed`,
          };
        }
        // The provider refused the submit before any job existed, so the refusal settles it as absent and nothing is billed by it.
        const absent = await confirmAbsentSubmit(deps.ledger, {
          idempotencyKey: key,
          evidence: `the provider refused the submit before a job id existed: ${error.kind}: ${error.message}`,
        });
        session.alerts.push(...absent.alerts);

        if (error.kind === "content_policy" || error.kind === "invalid_input") {
          return { kind: "planner", providerId: target.adapterId, error };
        }
        if (!shouldRetry(error) || attempt >= settings.maxAttempts) {
          return { kind: "exhausted", providerId: target.adapterId, reason: `${target.adapterId}: ${error.kind}: ${error.message}` };
        }
        await sleep(backoffFor(attempt));
      }
    } finally {
      if (!handedOver) await deps.buckets.release(target.adapterId);
    }
  }

  /**
   * Tries the targets from `from` in order, until one submits, or the planner must rewrite, or none is left. Its carry records what
   * was tried, so the final reason of the asset can name it.
   */
  async function launch(
    session: Session,
    input: ProduceInput,
    targets: readonly AssetTarget[],
    from: number,
    carry: AssetJobCarry,
    start: { submitNumber: number; fallback: Fallback },
  ): Promise<AssetStep> {
    const next: AssetJobCarry = structuredClone(carry);
    let submitNumber = start.submitNumber;
    let fallback = start.fallback;
    for (let index = from; index < targets.length; index += 1) {
      const target = targets[index] as AssetTarget;
      const open = await openBreaker(deps.breakers, target.adapterId, now());
      if (open !== null) {
        pushCapped(next.excluded, `${target.adapterId}: circuit open until ${new Date(open.openUntilMs).toISOString()}`);
        continue;
      }
      if (fallback !== null) {
        session.decisions.push({
          at: at(),
          chose: target.adapterId,
          alternatives: [],
          reason: `fell back from ${fallback.providerId} after ${fallback.reason}`,
          by: "scorer",
        });
        fallback = null;
      }
      const state: TargetState = { submitNumber, targetBilledUsd: 0, targetSubmits: 0, targetFirstEntryId: null };
      const result = await driveTarget(session, input, targets, index, state, { startAttempt: 1, slotHeld: false });
      submitNumber = state.submitNumber;
      if (result.kind === "submitted") {
        return { status: "submitted", job: parseAssetJob({ ...result.job, carry: next }), runAfterMs: 0 };
      }
      if (result.kind === "unsettled") {
        return { status: "unsettled", providerId: result.providerId, idempotencyKey: result.idempotencyKey, ledgerEntryId: result.ledgerEntryId, reason: result.reason };
      }
      if (result.kind === "planner") return { status: "failed", providerId: result.providerId, error: result.error };
      fallback = absorb(next, result);
    }
    return finalOutcome(next);
  }

  /** The video profiles of a catalog read, from its GET /videos/models body. Built once per read. */
  const catalogProfiles = new WeakMap<ModelCatalog, ReadonlyMap<string, VideoProfile>>();
  function profilesOf(catalog: ModelCatalog): ReadonlyMap<string, VideoProfile> {
    let profiles = catalogProfiles.get(catalog);
    if (profiles === undefined) {
      profiles = catalog.videoListing === null ? new Map<string, VideoProfile>() : videoProfilesFromListing(catalog.videoListing).profiles;
      catalogProfiles.set(catalog, profiles);
    }
    return profiles;
  }

  /** The catalog profile of each chosen video model this router has checked, so its submits and polls reach the same adapter. */
  const chosenProfiles = new Map<string, VideoProfile>();
  function withChosenProfiles(): ReadonlyMap<string, VideoProfile> {
    return new Map([...videoProfiles, ...chosenProfiles]);
  }

  type Chosen = { route: ResolvedRoute; entry: ModelCatalogEntry; profiles: ReadonlyMap<string, VideoProfile> };

  /**
   * The orchestrator's model for this spec, checked again against the catalog (Bible 10.5): the model must still be listed for the
   * spec's class and still fit the spec. Null when the spec has no choice. When the choice cannot be used, the reason is a decision and
   * the route table's targets are used instead (the fallback), as for a spec with no choice.
   */
  async function chosenFor(session: Session, input: ProduceInput): Promise<Chosen | null> {
    const choice = input.spec.modelChoice;
    if (choice === null) return null;
    const chosenId = `${choice.provider}:${choice.modelId}`;
    const fallBack = (why: string): null => {
      session.decisions.push({
        at: at(),
        chose: `route table for ${input.spec.modelClass}`,
        alternatives: [],
        reason: `the ${choice.source} choice ${chosenId} is not used: ${why}; the route table's targets are used (Bible 10.5)`,
        by: "scorer",
      });
      return null;
    };
    if (deps.catalog === undefined) return fallBack("this runtime has no model catalog to check it against");
    let read;
    try {
      read = await deps.catalog.read(input.workspaceId);
    } catch (error) {
      return fallBack(`the catalog could not be read (${excerpt(error instanceof Error ? error.message : "unknown error")})`);
    }
    if (read.status === "not_connected") return fallBack(read.reason);
    const entry = read.catalog.entries.find((candidate) => candidate.id === choice.modelId && candidate.modelClasses.includes(input.spec.modelClass));
    if (entry === undefined) {
      return fallBack(`it is no longer in the catalog for ${input.spec.modelClass} (read at ${read.catalog.readAt}; chosen from the read at ${choice.catalogReadAt})`);
    }
    const gap = rejectionOf(needOf(input.spec), entry);
    if (gap !== null) return fallBack(`it no longer fits the call (${gap.reason}: ${gap.detail})`);
    const profile = profilesOf(read.catalog).get(entry.id);
    if (profile !== undefined) chosenProfiles.set(entry.id, profile);
    return { route: chosenRouteOf(input.spec.modelClass, entry.id), entry, profiles: withChosenProfiles() };
  }

  /** Makes the first submit of an asset: scores the targets, serves a cache hit, and launches the best one that is free. */
  async function submit(input: ProduceInput): Promise<StepReport> {
    const session = newSession();
    const { spec, workspaceId } = input;

    // 0. A model the orchestrator chose (Bible 10.5) is the only target, priced from the catalog. A choice that cannot be used, or no
    // choice, routes by the route table as before.
    const chosen = await chosenFor(session, input);

    // 1. The routed targets of this model class, in priority order.
    let routes: ResolvedRoute[];
    try {
      routes = chosen === null ? deps.gateway.routes(spec.modelClass) : [chosen.route];
    } catch (error) {
      return report(session, { status: "not_connected", reasons: [error instanceof Error ? error.message : "no route"] });
    }
    if (routes.length === 0) {
      let reason = `no model is routed for ${spec.modelClass}; no call is made`;
      try {
        deps.gateway.route(spec.modelClass);
      } catch (error) {
        reason = error instanceof Error ? error.message : reason;
      }
      return report(session, { status: "not_connected", reasons: [reason] });
    }

    // 2. Filter: an adapter, the spec's needs, a known price, a connection, and a closed breaker.
    const candidates: Candidate[] = [];
    const notConnected: string[] = [];
    const excluded: string[] = [];
    for (const [priority, route] of routes.entries()) {
      // A target of a family this router switches off is not a candidate, so neither the first submit nor a fallback can reach it.
      if (deps.disabledFamilies !== undefined && isDisabledModel(route.model, deps.disabledFamilies)) {
        excluded.push(`${route.provider.id}:${route.model}: switched off by the model policy`);
        continue;
      }
      const built =
        chosen === null
          ? adapterFor(route, workspaceId, input.voiceId, input.speechSpeed, videoProfiles, input.voiceProvider)
          : adapterFor(route, workspaceId, input.voiceId, input.speechSpeed, chosen.profiles, input.voiceProvider);
      // A chosen model is estimated from its catalog price (Bible 10.5 step 5), not from the route table's price key.
      const adapter: RoutedAdapter | null =
        built === null || chosen === null ? built : { ...built, price: (priced: AssetSpec) => ({ estimateUsd: catalogEstimateUsd(chosen.entry, priced) }) };
      if (adapter === null) {
        excluded.push(`${route.provider.id}:${route.model}: no adapter for this provider`);
        continue;
      }
      // Connection first: it is a lookup that sends nothing, and a target that is not connected is reported as such
      // whatever its capabilities are.
      const connection = await adapter.connection(workspaceId);
      if (!connection.connected) {
        notConnected.push(`${adapter.id}: ${connection.reason}`);
        continue;
      }
      const gap = capabilityGap(spec, adapter.capabilities);
      if (gap !== null) {
        excluded.push(`${adapter.id}: ${gap}`);
        continue;
      }
      let estimateUsd: number;
      try {
        estimateUsd = adapter.price(spec).estimateUsd;
      } catch (error) {
        if (error instanceof EngineError && error.kind === "unknown_price") {
          excluded.push(`${adapter.id}: ${error.message}`);
          continue;
        }
        throw error;
      }
      const open = await openBreaker(deps.breakers, adapter.id, now());
      if (open !== null) {
        excluded.push(`${adapter.id}: circuit open until ${new Date(open.openUntilMs).toISOString()}`);
        continue;
      }
      candidates.push({ priority, route, adapter, estimateUsd, cacheKey: routeCacheKey(spec, adapter.id, input) });
      if (chosen !== null && spec.modelChoice !== null) {
        const price = chosen.entry.price;
        session.decisions.push({
          at: at(),
          chose: adapter.id,
          alternatives: [],
          reason: `the ${spec.modelChoice.source} choice from the catalog read at ${spec.modelChoice.catalogReadAt} (${spec.modelChoice.reason}), still listed in the read at ${chosen.entry.readAt}; estimated $${estimateUsd} from the catalog price $${price.usd} ${price.unit}${price.sku === null ? "" : ` (${price.sku})`}`,
          by: spec.modelChoice.source === "orchestrator" ? "director" : "scorer",
        });
      }
    }
    if (candidates.length === 0) {
      if (notConnected.length > 0 && excluded.length === 0) return report(session, { status: "not_connected", reasons: notConnected });
      return report(session, { status: "unavailable", reasons: [...notConnected, ...excluded] });
    }

    // 3. Score: each dimension is a value in [0, 1] or unknown. Unknowns are left out of the mean (score.ts).
    const windowStart = now() - settings.reliabilityWindowMs;
    const recordsById = new Map<string, AttemptRecord[]>();
    for (const candidate of candidates) {
      recordsById.set(candidate.adapter.id, await deps.stats.since(candidate.adapter.id, windowStart));
    }
    const costs = costEfficiencyValues(candidates.map((candidate) => ({ id: candidate.adapter.id, usd: candidate.estimateUsd })));
    const latencies = latencyValues(
      candidates.map((candidate) => ({ id: candidate.adapter.id, ms: medianLatencyMs(recordsById.get(candidate.adapter.id) ?? []) })),
    );
    const scored = candidates.map((candidate) => {
      const id = candidate.adapter.id;
      const values: DimensionValues = {
        taskFit: signals.passRate(candidate.route, input.visualType),
        outputQuality: signals.qualityScore(candidate.route),
        control: controlValue(candidate.adapter.capabilities),
        reliability: successRate(recordsById.get(id) ?? []),
        costEfficiency: costs.get(id) ?? null,
        latency: latencies.get(id) ?? null,
        continuity: continuityValue(id, input.continuityProvider),
      };
      return { ...candidate, score: scoreProvider(values, settings.weights) };
    });
    scored.sort((a, b) => compareScored({ score: a.score, priority: a.priority }, { score: b.score, priority: b.priority }));
    const winner = scored[0];
    if (winner === undefined) return report(session, { status: "unavailable", reasons: [...excluded] });
    session.decisions.push({
      at: at(),
      chose: winner.adapter.id,
      alternatives: scored
        .filter((candidate) => candidate.score.score !== null)
        .map((candidate) => ({ option: candidate.adapter.id, score: candidate.score.score as number })),
      reason: describeScore(winner.score, scored.length, excluded),
      by: "scorer",
    });

    // 4. Cache: a hit costs nothing and is recorded as a hit. Nothing is written to the ledger.
    for (const candidate of scored) {
      const hit = await deps.cache.get(workspaceId, candidate.cacheKey);
      if (hit !== null) {
        await deps.cache.recordHit({
          workspaceId,
          cacheKey: candidate.cacheKey,
          providerId: hit.providerId,
          requestId: input.requestId,
          shotId: spec.shotId,
          at: at(),
          savedUsd: hit.costUsd,
        });
        return report(session, { status: "done", asset: assetFromCache(hit, spec.modelClass) });
      }
    }

    // 5. Launch the targets in order. Each submit is authorized, and the first that submits becomes the job.
    const targets: AssetTarget[] = scored.map((candidate) => ({
      adapterId: candidate.adapter.id,
      provider: candidate.route.provider.id,
      model: candidate.route.model,
      cacheKey: candidate.cacheKey,
      estimateUsd: candidate.estimateUsd,
    }));
    const step = await launch(session, input, targets, 0, { ...emptyCarry(), excluded: capped(excluded) }, { submitNumber: 0, fallback: null });
    return report(session, step);
  }

  /** Checks that a job names this request, workspace and reservation, and that the spec is the one it was submitted with. */
  function checkJobFor(job: AssetJob, input: ProduceInput): void {
    if (job.workspaceId !== input.workspaceId || job.requestId !== input.requestId || job.reservationId !== input.reservationId) {
      throw new EngineError("invalid_input", `job ${job.idempotencyKey} belongs to another request or workspace`, { stage: input.stage });
    }
    const target = job.targets[job.targetIndex] as AssetTarget;
    if (input.spec.modelClass !== job.modelClass || routeCacheKey(input.spec, target.adapterId, input) !== target.cacheKey) {
      throw new EngineError("invalid_input", `the spec does not match the submit of job ${job.idempotencyKey}`, { stage: input.stage });
    }
  }

  /** Downloads a finished take through the gateway, checks it, and stores the bytes. A download that cannot be made is retried by the job; a file that fails the checks is a failed take. */
  async function storeTake(
    downloader: MediaDownloader,
    job: AssetJob,
    url: string,
  ): Promise<{ ok: true; uri: string } | { ok: false; error: ProviderError }> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await downloader.download({ providerId: job.provider, organizationId: job.workspaceId, url, maxBytes: OUTPUT_LIMITS.videoMaxBytes });
    } catch (error) {
      if (error instanceof EngineError && error.kind === "invalid_input") {
        return { ok: false, error: { kind: "unknown", retryable: false, message: `the take could not be downloaded: ${excerpt(error.message)}` } };
      }
      throw error;
    }
    const checked = normaliseVideo(bytes);
    if (!checked.ok) return { ok: false, error: { kind: "unknown", retryable: false, message: checked.reason } };
    const stored = await deps.media.put({
      workspaceId: job.workspaceId,
      bytes: checked.value.bytes,
      mediaType: VIDEO_MEDIA_TYPE,
      contentHash: contentHash(checked.value.bytes),
    });
    return { ok: true, uri: stored.uri };
  }

  /** The provider's answer, checked. Done needs a usable uri; a failure keeps the provider's error when it is well formed. */
  async function outcomeOf(
    job: AssetJob,
    polled: ProviderPoll,
    adapter: RoutedAdapter,
  ): Promise<{ ok: true; uri: string; mediaType: string | null; generationId: string | null } | { ok: false; error: ProviderError }> {
    if (polled.state === "done") {
      const checked = typeof polled.uri === "string" ? normaliseUri(polled.uri) : null;
      if (checked === null || !checked.ok) {
        return { ok: false, error: { kind: "unknown", retryable: false, message: "the provider reported done with no usable uri" } };
      }
      const details = adapter.detailsFor(job.jobRef);
      if (takeDownloader === null) {
        return { ok: true, uri: checked.value, mediaType: details?.mediaType ?? null, generationId: details?.generationId ?? null };
      }
      const taken = await storeTake(takeDownloader, job, checked.value);
      if (!taken.ok) return taken;
      return { ok: true, uri: taken.uri, mediaType: VIDEO_MEDIA_TYPE, generationId: details?.generationId ?? null };
    }
    const parsed = providerErrorSchema.safeParse(polled.error);
    return { ok: false, error: parsed.success ? parsed.data : { kind: "unknown", retryable: false, message: "the job failed with no reason" } };
  }

  /** Settles one job, with its slot. The caller has claimed the job; a failure releases the claim so the job can be settled again. */
  async function settleClaimed(job: AssetJob, polled: ProviderPoll, input: ProduceInput, slot: { bucketId: string | null }): Promise<StepReport> {
    const session = newSession();
    const target = job.targets[job.targetIndex] as AssetTarget;
    const adapter = adapterForTarget(target, job.modelClass, input);
    const startedMs = Date.parse(job.submittedAt);
    const latencyMs = now() - startedMs;
    const outcome = await outcomeOf(job, polled, adapter);

    // The ledger settles this submit to the provider's bill. A bill is taken only when it is a finite, non-negative number. With no bill
    // the submit stays unsettled: no estimate is booked, the asset is not cached, and nothing is retried or fallen back from.
    const bill = typeof polled.actualUsd === "number" && Number.isFinite(polled.actualUsd) && polled.actualUsd >= 0 ? polled.actualUsd : undefined;
    // The provider's own id for the call (contract v9), when the adapter has one: recorded on the entry whether or not the bill arrived, so a
    // held call can be settled later from it (budget/reconcile-holds.ts).
    const providerRef = adapter.detailsFor(job.jobRef)?.generationId;
    const reconciled = await reconcileSubmit(deps.ledger, {
      idempotencyKey: job.idempotencyKey,
      ...(bill === undefined ? {} : { billedUsd: bill }),
      ...(providerRef === undefined ? {} : { providerRef }),
    });
    session.alerts.push(...reconciled.alerts);
    if (!reconciled.settled || reconciled.entry.actualUsd === undefined) {
      await recordAttempt(session, target.adapterId, startedMs, outcome.ok ? null : outcome.error, outcome.ok ? latencyMs : null, job.attemptOnTarget);
      await freeSlot(slot, deps.buckets);
      return report(session, {
        status: "unsettled",
        providerId: target.adapterId,
        idempotencyKey: job.idempotencyKey,
        ledgerEntryId: reconciled.entry.entryId,
        reason: `${target.adapterId}: the provider reported no bill for ${job.idempotencyKey}, so the submit stays unsettled`,
      });
    }
    const targetBilledUsd = sumUsd([job.targetBilledUsd, reconciled.entry.actualUsd]);

    if (outcome.ok) {
      await recordAttempt(session, target.adapterId, startedMs, null, latencyMs, job.attemptOnTarget);
      const stored = await deps.cache.put({
        workspaceId: job.workspaceId,
        cacheKey: target.cacheKey,
        providerId: target.adapterId,
        modelClass: job.modelClass,
        uri: outcome.uri,
        costUsd: targetBilledUsd,
        mediaType: outcome.mediaType,
        storedAt: at(),
      });
      await freeSlot(slot, deps.buckets);
      return report(session, {
        status: "done",
        asset: {
          providerId: target.adapterId,
          modelClass: job.modelClass,
          uri: stored.uri,
          cacheKey: target.cacheKey,
          costUsd: targetBilledUsd,
          cacheHit: false,
          savedUsd: 0,
          ledgerEntryId: job.targetFirstEntryId ?? reconciled.entry.entryId,
          generationId: outcome.generationId,
          mediaType: stored.mediaType,
          submits: job.targetSubmits,
        },
      });
    }

    const failure = outcome.error;
    await recordAttempt(session, target.adapterId, startedMs, failure, null, job.attemptOnTarget);
    if (failure.kind === "content_policy" || failure.kind === "invalid_input") {
      await freeSlot(slot, deps.buckets);
      return report(session, { status: "failed", providerId: target.adapterId, error: failure });
    }

    const failureReason = `${target.adapterId}: ${failure.kind}: ${failure.message}`;
    const carry = structuredClone(job.carry);
    let submitNumber = job.submitNumber;
    let fallback: Fallback = { providerId: target.adapterId, reason: failureReason };
    if (shouldRetry(failure) && job.attemptOnTarget < settings.maxAttempts) {
      // The same target, the next attempt. The slot passes to the retry, which releases it if the retry cannot submit.
      slot.bucketId = null;
      const state: TargetState = {
        submitNumber: job.submitNumber,
        targetBilledUsd,
        targetSubmits: job.targetSubmits,
        targetFirstEntryId: job.targetFirstEntryId,
      };
      const retried = await driveTarget(session, input, job.targets, job.targetIndex, state, { startAttempt: job.attemptOnTarget + 1, slotHeld: true });
      if (retried.kind === "submitted") {
        return report(session, {
          status: "submitted",
          job: parseAssetJob({ ...retried.job, carry }),
          runAfterMs: backoffFor(job.attemptOnTarget),
        });
      }
      if (retried.kind === "planner") return report(session, { status: "failed", providerId: retried.providerId, error: retried.error });
      if (retried.kind === "unsettled") {
        return report(session, {
          status: "unsettled",
          providerId: retried.providerId,
          idempotencyKey: retried.idempotencyKey,
          ledgerEntryId: retried.ledgerEntryId,
          reason: retried.reason,
        });
      }
      submitNumber = state.submitNumber;
      pushCapped(carry.exhausted, failureReason);
      fallback = absorb(carry, retried) ?? fallback;
    } else {
      pushCapped(carry.exhausted, failureReason);
    }

    // The next target. This job's slot is released before it moves on.
    await freeSlot(slot, deps.buckets);
    const step = await launch(session, input, job.targets, job.targetIndex + 1, carry, { submitNumber, fallback });
    return report(session, step);
  }

  /**
   * Settles one job when its provider answer is finished (Bible 15.2). Settling the same job again returns the first result and
   * changes nothing: no provider call, no ledger write, no stats record. A settle that is running in another call is refused as
   * retryable, so two polls of one job cannot both retry the same submit.
   */
  async function settle(job: AssetJob, polled: ProviderPoll, input: ProduceInput): Promise<StepReport> {
    const checked = parseAssetJob(job);
    checkJobFor(checked, input);
    if (polled.state === "pending") {
      throw new EngineError("invalid_input", `job ${checked.idempotencyKey} was handed a pending answer; only a finished poll settles it`, { stage: input.stage });
    }
    const key = `${checked.workspaceId}\u0000${checked.idempotencyKey}`;
    const owner = globalThis.crypto.randomUUID();
    const claim = await settlements.claim(key, { owner, nowMs: now(), leaseMs: thresholds.jobs.leaseMs.generation });
    if (claim.status === "settled") return claim.value;
    if (claim.status === "in_progress") {
      throw new EngineError("conflict", `job ${checked.idempotencyKey} is being settled by another run; it is retried`, { stage: input.stage, retryable: true });
    }
    const slot: { bucketId: string | null } = { bucketId: checked.providerId };
    try {
      const result = await settleClaimed(checked, polled, input, slot);
      await settlements.complete(key, owner, result);
      return result;
    } catch (error) {
      await freeSlot(slot, deps.buckets);
      await settlements.release(key, owner);
      throw error;
    }
  }

  /** Polls one job until it is finished or its deadline passes. A timeout cancels the job when the adapter can (Bible 10.4). */
  async function awaitTerminal(adapter: RoutedAdapter, jobRef: string, startedMs: number): Promise<ProviderPoll> {
    const deadline = startedMs + settings.pollTimeoutMs;
    for (;;) {
      let poll: ProviderPoll;
      try {
        poll = await adapter.poll(jobRef);
      } catch (thrown) {
        const transient = classifyError(thrown);
        if (!transient.retryable) return { state: "failed", error: transient };
        poll = { state: "pending" };
      }
      if (poll.state !== "pending") return poll;
      const remaining = deadline - now();
      if (remaining <= 0) {
        let note = "";
        if (adapter.cancel !== undefined) {
          try {
            await adapter.cancel(jobRef);
            note = " (cancelled)";
          } catch (thrown) {
            note = ` (cancel failed: ${classifyError(thrown).message})`;
          }
        }
        return { state: "failed", error: { kind: "timeout", retryable: true, message: `no result within ${settings.pollTimeoutMs} ms${note}` } };
      }
      await sleep(Math.min(settings.pollIntervalMs, remaining));
    }
  }

  /**
   * One poll of a submitted job, without waiting. The durable poller uses it; produce waits instead. A poll past the job's deadline is a
   * timeout: the job is cancelled where the provider allows it, and the poll is finished as failed, so settle can close it.
   */
  async function pollOnce(job: AssetJob, input: ProduceInput): Promise<ProviderPoll> {
    const checked = parseAssetJob(job);
    checkJobFor(checked, input);
    const target = checked.targets[checked.targetIndex] as AssetTarget;
    const adapter = adapterForTarget(target, checked.modelClass, input);
    let poll: ProviderPoll;
    try {
      poll = await adapter.poll(checked.jobRef);
    } catch (thrown) {
      const transient = classifyError(thrown);
      if (!transient.retryable) return { state: "failed", error: transient };
      poll = { state: "pending" };
    }
    if (poll.state !== "pending") return poll;
    if (now() < Date.parse(checked.submittedAt) + settings.pollTimeoutMs) return poll;
    let note = "";
    if (adapter.cancel !== undefined) {
      try {
        await adapter.cancel(checked.jobRef);
        note = " (cancelled)";
      } catch (thrown) {
        note = ` (cancel failed: ${classifyError(thrown).message})`;
      }
    }
    return { state: "failed", error: { kind: "timeout", retryable: true, message: `no result within ${settings.pollTimeoutMs} ms${note}` } };
  }

  /** Submit, then poll and settle each job until the asset is terminal. For synchronous callers and tests. */
  async function produce(input: ProduceInput): Promise<ProduceReport> {
    const decisions: Decision[] = [];
    const alerts: BudgetAlert[] = [];
    const attempts: AttemptLog[] = [];
    const absorbReport = (result: StepReport): AssetStep => {
      decisions.push(...result.decisions);
      alerts.push(...result.alerts);
      attempts.push(...result.attempts);
      return result.step;
    };

    let step = absorbReport(await submit(input));
    while (step.status === "submitted") {
      const job = step.job;
      const target = job.targets[job.targetIndex] as AssetTarget;
      let polled: ProviderPoll;
      try {
        const adapter = adapterForTarget(target, job.modelClass, input);
        if (step.runAfterMs > 0) await sleep(step.runAfterMs);
        polled = await awaitTerminal(adapter, job.jobRef, Date.parse(job.submittedAt));
      } catch (error) {
        await deps.buckets.release(target.adapterId);
        throw error;
      }
      step = absorbReport(await settle(job, polled, input));
    }
    return { outcome: step, decisions, alerts, attempts };
  }

  return { produce, submit, settle, pollOnce };
}

type Session = {
  decisions: Decision[];
  alerts: BudgetAlert[];
  attempts: AttemptLog[];
};

function newSession(): Session {
  return { decisions: [], alerts: [], attempts: [] };
}

function describeScore(score: ScoreResult, eligible: number, excluded: string[]): string {
  const value = score.score === null ? "unknown (no known dimension)" : score.score.toFixed(4);
  const known = score.known.length > 0 ? score.known.join(", ") : "none";
  const unknown = score.unknown.length > 0 ? score.unknown.join(", ") : "none";
  const left = excluded.length > 0 ? `; excluded: ${excluded.join("; ")}` : "";
  return `score ${value} over ${eligible} eligible; known dimensions: ${known}; unknown and left out of the mean, not 0 or 1: ${unknown}${left}`;
}

function assetFromCache(hit: CachedAsset, modelClass: ModelClass): ProducedAsset {
  return {
    providerId: hit.providerId,
    modelClass,
    uri: hit.uri,
    cacheKey: hit.cacheKey,
    costUsd: 0,
    cacheHit: true,
    savedUsd: hit.costUsd,
    ledgerEntryId: null,
    generationId: null,
    mediaType: hit.mediaType,
    submits: 0,
  };
}
