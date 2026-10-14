// The asset router (Bible 10.2 and 10.4). It takes one AssetSpec, lists the routed targets of its model class from the gateway
// (config/routes.ts), filters them, scores them, serves a cache hit at $0, and otherwise runs the first target that is free to
// run: concurrency bucket, circuit breaker, then one paid call through the gateway's paidCall (budget ledger) with the cache
// key as the idempotency key.
//
// Retries (Bible 10.4). Inside one paid call, for one provider:
//   rate_limit and server (and an unknown error the adapter marks retryable): retry on the same provider with exponential
//   backoff, up to thresholds.jobs.maxAttempts submits in total; then the next provider.
//   timeout: no retry; the job is cancelled when the adapter can cancel, and the next provider runs.
//   content_policy and invalid_input: no retry and no fallback; the failure goes back to the planner.
//   any other unknown error: no retry; the next provider runs.
// Every submit, including a refused one, is held on the ledger until its bill is known. The actual cost of a candidate is the
// sum over its submits of the bill the provider reported, or the candidate's list estimate where no bill was reported. That
// never under-counts a billed call.
//
// The router never sends a request itself: every call is an adapter's, and every adapter calls only the gateway.

import { adapters } from "../config/adapters.ts";
import { EngineError } from "../contracts/errors.ts";
import { assetCacheKey, type AssetSpec, type ProviderError, type ProviderPoll } from "../contracts/assets.ts";
import { sumUsd } from "../contracts/money.ts";
import type { Decision } from "../contracts/plan.ts";
import type { ModelClass } from "../contracts/plan.ts";
import { thresholds } from "../config/thresholds.ts";
import type { BudgetAlert } from "../budget/reserve.ts";
import type { LedgerStore } from "../budget/store.ts";
import { paidCall, type PaidCallOutcome, type PaidRun } from "../gateway/paid.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import type { MediaStore, RoutedAdapter } from "./adapter.ts";
import { classifyError, type ProviderErrorKind } from "./classify.ts";
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
import { adapterFor, type AdapterContext } from "./providers/index.ts";
import type { VideoProfile } from "./providers/openrouterVideo.ts";

/** The router's timing values, read from config/adapters.ts (adapters@1). */
export const ROUTER_CONSTANTS = {
  pollIntervalMs: adapters.polling.intervalMs.value,
  backoffBaseMs: adapters.retry.backoffBaseMs.value,
  backoffCapMs: adapters.retry.backoffCapMs.value,
  reliabilityWindowMs: adapters.reliabilityWindowMs,
} as const;

export type RouterSettings = {
  /** Submits per provider for retryable errors, including the first. */
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
  ledger: LedgerStore;
  cache: AssetCache;
  stats: ProviderStats;
  breakers: BreakerStore;
  buckets: BucketStore;
  media: MediaStore;
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
};

export type ProducedAsset = {
  /** The adapter id: provider and model. */
  providerId: string;
  modelClass: ModelClass;
  uri: string;
  cacheKey: string;
  /** What the call cost. Zero for a cache hit. */
  costUsd: number;
  /** True when some submit had no reported bill, so its list estimate is in the cost. */
  costIsEstimate: boolean;
  cacheHit: boolean;
  /** On a cache hit, the cost the hit saved. */
  savedUsd: number;
  ledgerEntryId: string | null;
  generationId: string | null;
  mediaType: string | null;
  /** Submits made for this asset (0 on a cache hit). */
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

type Candidate = {
  priority: number;
  route: ResolvedRoute;
  adapter: RoutedAdapter;
  estimateUsd: number;
  cacheKey: string;
};

type CandidateOutcome =
  | { kind: "asset"; uri: string; mediaType: string | null; generationId: string | null; submits: number; allBilled: boolean }
  | { kind: "planner"; error: ProviderError; submits: number }
  | { kind: "exhausted"; error: ProviderError; submits: number };

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

export function createAssetRouter(deps: RouterDeps): AssetRouter {
  const settings: RouterSettings = { ...defaultRouterSettings(), ...deps.settings };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepFor;
  const signals = deps.signals ?? NO_SIGNALS;
  const videoProfiles = deps.videoProfiles ?? new Map<string, VideoProfile>();

  async function produce(input: ProduceInput): Promise<ProduceReport> {
    const { spec, workspaceId } = input;
    const decisions: Decision[] = [];
    const alerts: BudgetAlert[] = [];
    const attempts: AttemptLog[] = [];
    const at = (): string => new Date(now()).toISOString();
    const report = (outcome: ProduceOutcome): ProduceReport => ({ outcome, decisions, alerts, attempts });

    // ---- one candidate, inside its paid call ----------------------------------------------------------------------------

    async function runCandidate(candidate: Candidate, runInput: ProduceInput): Promise<PaidRun<CandidateOutcome>> {
      const { adapter } = candidate;
      const id = adapter.id;
      const calls: Array<{ billedUsd: number | null }> = [];
      const finish = (error: ProviderError): CandidateOutcome =>
        error.kind === "content_policy" || error.kind === "invalid_input"
          ? { kind: "planner", error, submits: calls.length }
          : { kind: "exhausted", error, submits: calls.length };
      const settle = (outcome: CandidateOutcome): PaidRun<CandidateOutcome> => ({
        value: outcome,
        actualUsd: sumUsd(calls.map((call) => call.billedUsd ?? candidate.estimateUsd)),
      });

      for (let attempt = 1; ; attempt += 1) {
        const startedMs = now();
        const call = { billedUsd: null as number | null };
        calls.push(call);

        let error: ProviderError | null;
        let uri: string | null = null;
        let generationId: string | null = null;
        let mediaType: string | null = null;
        try {
          const { jobRef } = await adapter.submit(runInput.spec, candidate.cacheKey);
          const poll = await awaitTerminal(adapter, jobRef, startedMs);
          call.billedUsd = poll.actualUsd ?? null;
          if (poll.state === "done" && poll.uri !== undefined) {
            error = null;
            uri = poll.uri;
            const details = adapter.detailsFor(jobRef);
            generationId = details?.generationId ?? null;
            mediaType = details?.mediaType ?? null;
          } else if (poll.state === "done") {
            error = { kind: "unknown", retryable: false, message: "the provider reported done with no uri" };
          } else {
            error = poll.error ?? { kind: "unknown", retryable: false, message: "the job failed with no reason" };
          }
        } catch (thrown) {
          error = classifyError(thrown);
        }

        const latencyMs = error === null ? now() - startedMs : null;
        await recordAttempt(id, startedMs, error, latencyMs, attempt);

        if (error === null && uri !== null) {
          const allBilled = calls.every((item) => item.billedUsd !== null);
          return settle({ kind: "asset", uri, mediaType, generationId, submits: calls.length, allBilled });
        }
        const failure = error ?? { kind: "unknown", retryable: false, message: "no result" };
        if (shouldRetry(failure) && attempt < settings.maxAttempts) {
          await sleep(Math.min(settings.backoffCapMs, settings.backoffBaseMs * 2 ** (attempt - 1)));
          continue;
        }
        return settle(finish(failure));
      }
    }

    /** Polls until the job is done or failed, or until the poll deadline. A timeout cancels the job when the adapter can. */
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

    async function recordAttempt(providerId: string, startedMs: number, error: ProviderError | null, latencyMs: number | null, attempt: number): Promise<void> {
      const outcome = outcomeFor(error);
      const errorKind = error === null ? null : error.kind;
      attempts.push({ providerId, attempt, atMs: startedMs, outcome, errorKind, latencyMs });
      await deps.stats.record({ providerId, atMs: startedMs, outcome, latencyMs, errorKind });
      await evaluateBreaker(deps.stats, deps.breakers, providerId, now(), settings.breaker);
    }

    const context: AdapterContext = {
      gateway: deps.gateway,
      organizationId: workspaceId,
      workspaceId,
      media: deps.media,
      videoProfiles,
      voice: input.voiceId ?? null,
    };

    // 1. The routed targets of this model class, in priority order.
    let routes: ResolvedRoute[];
    try {
      routes = deps.gateway.routes(spec.modelClass);
    } catch (error) {
      return report({ status: "not_connected", reasons: [error instanceof Error ? error.message : "no route"] });
    }
    if (routes.length === 0) {
      let reason = `no model is routed for ${spec.modelClass}; no call is made`;
      try {
        deps.gateway.route(spec.modelClass);
      } catch (error) {
        reason = error instanceof Error ? error.message : reason;
      }
      return report({ status: "not_connected", reasons: [reason] });
    }

    // 2. Filter: an adapter, the spec's needs, a known price, a connection, and a closed breaker.
    const candidates: Candidate[] = [];
    const notConnected: string[] = [];
    const excluded: string[] = [];
    for (const [priority, route] of routes.entries()) {
      const adapter = adapterFor(route, context);
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
      if (notConnected.length > 0 && excluded.length === 0) return report({ status: "not_connected", reasons: notConnected });
      return report({ status: "unavailable", reasons: [...notConnected, ...excluded] });
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
    const ordered = scored;
    const winner = ordered[0];
    if (winner === undefined) return report({ status: "unavailable", reasons: [...excluded] });
    decisions.push({
      at: at(),
      chose: winner.adapter.id,
      alternatives: ordered
        .filter((candidate) => candidate.score.score !== null)
        .map((candidate) => ({ option: candidate.adapter.id, score: candidate.score.score as number })),
      reason: describeScore(winner.score, ordered.length, excluded),
      by: "scorer",
    });

    // 4. Cache: a hit costs nothing and is recorded as a hit. Nothing is written to the ledger.
    for (const candidate of ordered) {
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
        return report({ status: "done", asset: assetFromCache(hit, spec.modelClass) });
      }
    }

    // 5. Run the candidates in order. Each runs under one paid call, keyed by its cache key.
    const bucketLimit = settings.concurrency[bucketClassFor(spec.modelClass)];
    const exhausted: string[] = [];
    const refused: string[] = [];
    const queued: string[] = [];
    let duplicate: { providerId: string; ledgerEntryId: string } | null = null;

    for (const [index, candidate] of ordered.entries()) {
      const id = candidate.adapter.id;
      if (!(await deps.buckets.tryAcquire(id, bucketLimit))) {
        queued.push(`${id}: concurrency bucket full (${bucketLimit})`);
        continue;
      }
      const paid: PaidCallOutcome<CandidateOutcome> = await paidCall(
        {
          ledger: deps.ledger,
          reservationId: input.reservationId,
          stage: input.stage,
          route: candidate.route,
          estimateUsd: candidate.estimateUsd,
          idempotencyKey: candidate.cacheKey,
          at: at(),
        },
        () => runCandidate(candidate, input),
      ).finally(() => deps.buckets.release(id));

      if (paid.status === "refused") {
        refused.push(`${id}: ${paid.reason}`);
        alerts.push(...paid.alerts);
        continue;
      }
      if (paid.status === "duplicate") {
        duplicate = { providerId: id, ledgerEntryId: paid.entry.entryId };
        continue;
      }
      alerts.push(...paid.alerts);
      const value = paid.value;

      if (value.kind === "asset") {
        const costUsd = paid.entry.actualUsd ?? candidate.estimateUsd;
        const stored = await deps.cache.put({
          workspaceId,
          cacheKey: candidate.cacheKey,
          providerId: id,
          modelClass: spec.modelClass,
          uri: value.uri,
          costUsd,
          mediaType: value.mediaType,
          storedAt: at(),
        });
        return report({
          status: "done",
          asset: {
            providerId: id,
            modelClass: spec.modelClass,
            uri: stored.uri,
            cacheKey: candidate.cacheKey,
            costUsd,
            costIsEstimate: !value.allBilled,
            cacheHit: false,
            savedUsd: 0,
            ledgerEntryId: paid.entry.entryId,
            generationId: value.generationId,
            mediaType: stored.mediaType,
            submits: value.submits,
          },
        });
      }
      if (value.kind === "planner") {
        return report({ status: "failed", providerId: id, error: value.error });
      }

      // Exhausted: the next candidate runs, and the switch is a Decision.
      const reason = `${id}: ${value.error.kind}: ${value.error.message}`;
      exhausted.push(reason);
      const next = ordered[index + 1];
      if (next !== undefined) {
        decisions.push({
          at: at(),
          chose: next.adapter.id,
          alternatives: [],
          reason: `fell back from ${id} after ${reason}`,
          by: "scorer",
        });
      }
    }

    if (queued.length > 0) return report({ status: "queued", reasons: [...queued, ...exhausted] });
    if (duplicate !== null) return report({ status: "duplicate", ...duplicate });
    if (refused.length > 0 && exhausted.length === 0) return report({ status: "refused", reasons: refused });
    return report({ status: "unavailable", reasons: [...exhausted, ...refused] });

  }

  return { produce };
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
