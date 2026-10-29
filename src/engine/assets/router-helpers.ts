// The asset router's pure helpers: the capability check, the refusal and retry rules, the carry and its outcome, the concurrency
// slot, and the session log. Moved out of engine/assets/router.ts unchanged (coding loop, T9a). router.ts re-exports the
// public names.

import type { AssetSpec, ProviderError } from "../contracts/assets.ts";
import type { Decision } from "../contracts/plan.ts";
import type { ModelClass } from "../contracts/plan.ts";
import type { BudgetAlert } from "../budget/reserve.ts";
import type { CachedAsset } from "./cache.ts";
import type { AttemptOutcome } from "./stats.ts";
import type { BucketStore } from "./buckets.ts";
import type { ScoreResult } from "./score.ts";
import { CARRY_LIMIT, type AssetJobCarry } from "./job.ts";
import type { ProducedAsset, AttemptLog, ProduceOutcome, TargetResult, Fallback } from "./router-types.ts";

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

export function isDefinitiveRefusal(error: ProviderError): boolean {
  return DEFINITIVE_REFUSALS.has(error.kind);
}

/** A definitive rate limit is retried with a new attempt key, because the refused submit is settled as absent first. */

export function shouldRetry(error: ProviderError): boolean {
  return error.kind === "rate_limit";
}

export function outcomeFor(error: ProviderError | null): AttemptOutcome {
  if (error === null) return "success";
  return error.kind === "content_policy" || error.kind === "invalid_input" ? "request_refused" : "provider_failure";
}

export function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pushCapped(list: string[], item: string): void {
  if (list.length < CARRY_LIMIT) list.push(item);
}

export function emptyCarry(): AssetJobCarry {
  return { excluded: [], exhausted: [], refused: [], queued: [], duplicate: null };
}

/** Records what a non-submitted target result leaves behind, and returns the fallback it names (if it failed). */

export function absorb(carry: AssetJobCarry, result: Exclude<TargetResult, { kind: "submitted" } | { kind: "planner" } | { kind: "unsettled" }>): Fallback {
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

export function finalOutcome(carry: AssetJobCarry): ProduceOutcome {
  if (carry.queued.length > 0) return { status: "queued", reasons: [...carry.queued, ...carry.exhausted] };
  if (carry.duplicate !== null) return { status: "duplicate", providerId: carry.duplicate.providerId, ledgerEntryId: carry.duplicate.ledgerEntryId };
  if (carry.refused.length > 0 && carry.exhausted.length === 0) return { status: "refused", reasons: carry.refused };
  return { status: "unavailable", reasons: [...carry.exhausted, ...carry.refused, ...carry.excluded] };
}

/** Releases a concurrency slot once. A slot is held by one job at a time; the holder clears its own reference before handing it on. */

export async function freeSlot(slot: { bucketId: string | null }, buckets: BucketStore): Promise<void> {
  const id = slot.bucketId;
  if (id === null) return;
  slot.bucketId = null;
  await buckets.release(id);
}

export type Session = {
  decisions: Decision[];
  alerts: BudgetAlert[];
  attempts: AttemptLog[];
};

export function newSession(): Session {
  return { decisions: [], alerts: [], attempts: [] };
}

export function describeScore(score: ScoreResult, eligible: number, excluded: string[]): string {
  const value = score.score === null ? "unknown (no known dimension)" : score.score.toFixed(4);
  const known = score.known.length > 0 ? score.known.join(", ") : "none";
  const unknown = score.unknown.length > 0 ? score.unknown.join(", ") : "none";
  const left = excluded.length > 0 ? `; excluded: ${excluded.join("; ")}` : "";
  return `score ${value} over ${eligible} eligible; known dimensions: ${known}; unknown and left out of the mean, not 0 or 1: ${unknown}${left}`;
}

export function assetFromCache(hit: CachedAsset, modelClass: ModelClass): ProducedAsset {
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
