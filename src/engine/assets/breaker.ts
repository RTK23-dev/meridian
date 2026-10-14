// The circuit breaker (Bible 10.4): a provider with over 30% failures in 10 minutes is skipped for 10 minutes. The values are
// read from config/thresholds.ts by the router. The window counts provider-side attempts only (a refused request is not the
// provider's health). After a skip the window starts when the skip ended, so a recovered provider starts clean.
//
// Open question for the lead: the rule as written has no minimum sample size, so one failed attempt in an empty window is
// 100% and trips the breaker. A minimum is a configuration change (config/thresholds.ts), not made here.

import type { ProviderStats } from "./stats.ts";

export type BreakerSettings = { failureShare: number; windowMs: number; skipMs: number };

export type BreakerState = { trippedAtMs: number; openUntilMs: number };

export interface BreakerStore {
  get(providerId: string): Promise<BreakerState | null>;
  set(providerId: string, state: BreakerState): Promise<void>;
}

export function memoryBreakerStore(): BreakerStore {
  const states = new Map<string, BreakerState>();
  return {
    async get(providerId) {
      const found = states.get(providerId);
      return found ? { ...found } : null;
    },
    async set(providerId, state) {
      states.set(providerId, { ...state });
    },
  };
}

/** The open state of a provider at a time, or null when it is closed. */
export async function openBreaker(store: BreakerStore, providerId: string, nowMs: number): Promise<BreakerState | null> {
  const state = await store.get(providerId);
  return state !== null && state.openUntilMs > nowMs ? state : null;
}

/**
 * Trips the breaker when the provider-side failure share in the window is over the limit. Returns the new state when this
 * call tripped it, and null otherwise. An open breaker is not evaluated again.
 */
export async function evaluateBreaker(
  stats: ProviderStats,
  store: BreakerStore,
  providerId: string,
  nowMs: number,
  settings: BreakerSettings,
): Promise<BreakerState | null> {
  const state = await store.get(providerId);
  if (state !== null && state.openUntilMs > nowMs) return null;
  // The window starts when the last skip ended. Attempts still in flight when the breaker tripped fall inside the skip and are
  // not counted, so a recovered provider gets a clean window rather than a re-trip from its own in-flight retries.
  const windowStart = Math.max(nowMs - settings.windowMs, state?.openUntilMs ?? Number.NEGATIVE_INFINITY);
  const window = (await stats.since(providerId, windowStart)).filter((record) => record.outcome !== "request_refused");
  if (window.length === 0) return null;
  const failures = window.filter((record) => record.outcome === "provider_failure").length;
  if (failures / window.length <= settings.failureShare) return null;
  const tripped: BreakerState = { trippedAtMs: nowMs, openUntilMs: nowMs + settings.skipMs };
  await store.set(providerId, tripped);
  return tripped;
}
