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
// Retries (Bible 10.4). rate_limit, server and a retryable unknown error retry on the same target with backoff, up to
// thresholds.jobs.maxAttempts submits in total (the backoff waits inside submit, and before the first poll after settle). timeout
// does not retry: the next target runs. content_policy and invalid_input do not retry and do not fall back: they return `failed`
// for the planner. Any other error moves to the next target.
//
// Ledger (Bible 14.1). Every submit is authorized before it is sent, under its own key: the first submit of a target uses the
// target's cache key, and a retry uses that key with an attempt suffix. Each submit is reconciled to its bill, or to its list
// estimate when the provider reported none (a refused or failed submit is held at its estimate, since the router cannot know
// whether it was billed). The asset's cost is the sum over the submits of its winning target.
//
// The router never sends a request itself: every call is an adapter's, and every adapter calls only the gateway.

import { adapters } from "../config/adapters.ts";
import { EngineError } from "../contracts/errors.ts";
import { assetCacheKey, providerErrorSchema, type AssetSpec, type ProviderError, type ProviderPoll } from "../contracts/assets.ts";
import { contentHash } from "../contracts/hash.ts";
import { sumUsd } from "../contracts/money.ts";
import type { Decision } from "../contracts/plan.ts";
import type { ModelClass } from "../contracts/plan.ts";
import { thresholds } from "../config/thresholds.ts";
import type { BudgetAlert } from "../budget/reserve.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import { gatewayDownloader, type MediaDownloader } from "../gateway/download.ts";
import type { LockableLedger } from "../gateway/paid.ts";
import { type MediaStore, type RoutedAdapter } from "./adapter.ts";
import { classifyError, excerpt, type ProviderErrorKind } from "./classify.ts";
import { type AssetCache, type CachedAsset } from "./cache.ts";
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
import type { VideoProfile } from "./providers/openrouterVideo.ts";
import { authorizeSubmit, reconcileSubmit } from "./ledger-steps.ts";
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
  /** The speaking rate for speech routes (1 is the vendor's default). Part of the adapter's identity, so it is part of the cache key. */
  speechSpeed?: number;
};

export type ProducedAsset = {
  /** The adapter id: provider and model. */
  providerId: string;
  modelClass: ModelClass;
  uri: string;
  cacheKey: string;
  /** What the asset cost: the sum over the submits of its winning target. Zero for a cache hit. */
  costUsd: number;
  /** True when some submit had no reported bill, so its list estimate is in the cost. */
  costIsEstimate: boolean;
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
  | { status: "unavailable"; reasons: string[] };

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
  targetAllBilled: boolean;
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
  | { kind: "exhausted"; providerId: string; reason: string };

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

function shouldRetry(error: ProviderError): boolean {
  return error.kind === "rate_limit" || error.kind === "server" || (error.kind === "unknown" && error.retryable);
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
function absorb(carry: AssetJobCarry, result: Exclude<TargetResult, { kind: "submitted" } | { kind: "planner" }>): Fallback {
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

  function contextFor(workspaceId: string, voiceId: string | null | undefined, speechSpeed: number | undefined): AdapterContext {
    return {
      gateway: deps.gateway,
      organizationId: workspaceId,
      workspaceId,
      media: deps.media,
      videoProfiles,
      voice: voiceId ?? null,
      speechSpeed: speechSpeed ?? 1,
    };
  }

  /**
   * The adapter for a route, built once per capability, route, workspace and voice. Keeping the instance matters for adapters that
   * keep a job's result in process (images): the poll must reach the instance that submitted the job.
   */
  function adapterFor(route: ResolvedRoute, workspaceId: string, voiceId: string | null | undefined, speechSpeed?: number): RoutedAdapter | null {
    const key = `${route.capability}\u0000${route.provider.id}:${route.model}\u0000${workspaceId}\u0000${voiceId ?? ""}\u0000${speechSpeed ?? 1}`;
    const cached = adapterCache.get(key);
    if (cached) return cached;
    const adapter = buildAdapter(route, contextFor(workspaceId, voiceId, speechSpeed));
    if (adapter !== null) adapterCache.set(key, adapter);
    return adapter;
  }

  /** The adapter of a job's target, looked up again so that a route that has changed since the submit fails closed. */
  function adapterForTarget(target: AssetTarget, modelClass: ModelClass, input: ProduceInput): RoutedAdapter {
    const route = deps.gateway.routes(modelClass).find((candidate) => candidate.provider.id === target.provider && candidate.model === target.model);
    if (route === undefined) {
      throw new EngineError("config", `${target.adapterId} is no longer routed for ${modelClass}; the job cannot be settled`, { stage: input.stage });
    }
    const adapter = adapterFor(route, input.workspaceId, input.voiceId, input.speechSpeed);
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
            targetAllBilled: state.targetAllBilled,
            targetSubmits: state.targetSubmits,
            targetFirstEntryId: state.targetFirstEntryId,
          };
          parseAssetJob({ ...job, carry: emptyCarry() });
          handedOver = true;
          return { kind: "submitted", job };
        }
        error ??= { kind: "unknown", retryable: false, message: "the provider returned no usable job id" };

        // The submit failed before a job existed. It is held at its estimate until the books say otherwise (Bible 14.1 step 4).
        const held = await reconcileSubmit(deps.ledger, { idempotencyKey: key, listPriceUsd: target.estimateUsd });
        session.alerts.push(...held.alerts);
        state.targetBilledUsd = sumUsd([state.targetBilledUsd, held.entry.actualUsd ?? target.estimateUsd]);
        state.targetAllBilled = false;
        await recordAttempt(session, target.adapterId, startedMs, error, null, attempt);

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
      const state: TargetState = { submitNumber, targetBilledUsd: 0, targetAllBilled: true, targetSubmits: 0, targetFirstEntryId: null };
      const result = await driveTarget(session, input, targets, index, state, { startAttempt: 1, slotHeld: false });
      submitNumber = state.submitNumber;
      if (result.kind === "submitted") {
        return { status: "submitted", job: parseAssetJob({ ...result.job, carry: next }), runAfterMs: 0 };
      }
      if (result.kind === "planner") return { status: "failed", providerId: result.providerId, error: result.error };
      fallback = absorb(next, result);
    }
    return finalOutcome(next);
  }

  /** Makes the first submit of an asset: scores the targets, serves a cache hit, and launches the best one that is free. */
  async function submit(input: ProduceInput): Promise<StepReport> {
    const session = newSession();
    const { spec, workspaceId } = input;

    // 1. The routed targets of this model class, in priority order.
    let routes: ResolvedRoute[];
    try {
      routes = deps.gateway.routes(spec.modelClass);
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
      const adapter = adapterFor(route, workspaceId, input.voiceId, input.speechSpeed);
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
      candidates.push({ priority, route, adapter, estimateUsd, cacheKey: assetCacheKey(spec, adapter.id) });
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
    if (input.spec.modelClass !== job.modelClass || assetCacheKey(input.spec, target.adapterId) !== target.cacheKey) {
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

    // The ledger holds this submit at its bill. A bill is taken only when it is a finite, non-negative number.
    const bill = typeof polled.actualUsd === "number" && Number.isFinite(polled.actualUsd) && polled.actualUsd >= 0 ? polled.actualUsd : undefined;
    const reconciled = await reconcileSubmit(deps.ledger, {
      idempotencyKey: job.idempotencyKey,
      ...(bill === undefined ? {} : { actualUsd: bill }),
      listPriceUsd: target.estimateUsd,
    });
    session.alerts.push(...reconciled.alerts);
    const targetBilledUsd = sumUsd([job.targetBilledUsd, reconciled.entry.actualUsd ?? target.estimateUsd]);
    const targetAllBilled = job.targetAllBilled && bill !== undefined;

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
          costIsEstimate: !targetAllBilled,
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
        targetAllBilled,
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

  return { produce, submit, settle };
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
    costIsEstimate: false,
    cacheHit: true,
    savedUsd: hit.costUsd,
    ledgerEntryId: null,
    generationId: null,
    mediaType: hit.mediaType,
    submits: 0,
  };
}
