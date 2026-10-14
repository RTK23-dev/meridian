// Provider attempt history (Bible 10.2 reliability and latency; 10.4 breaker). One record per submit attempt, appended by the
// router. Provider health is global, not per tenant, so the history carries no workspace.

import type { ProviderErrorKind } from "./classify.ts";

export type AttemptOutcome =
  /** The asset was produced. */
  | "success"
  /** The provider failed: rate limit, timeout, server or an unknown failure. These count against the breaker. */
  | "provider_failure"
  /** The request itself was refused (content policy or invalid input). This is not the provider's health. */
  | "request_refused";

export type AttemptRecord = {
  providerId: string;
  atMs: number;
  outcome: AttemptOutcome;
  latencyMs: number | null;
  errorKind: ProviderErrorKind | null;
};

export interface ProviderStats {
  record(record: AttemptRecord): Promise<void>;
  /** Records for a provider with atMs at or after sinceMs, in the order they were recorded. */
  since(providerId: string, sinceMs: number): Promise<AttemptRecord[]>;
}

export function memoryProviderStats(): ProviderStats {
  const records: AttemptRecord[] = [];
  return {
    async record(record) {
      records.push({ ...record });
    },
    async since(providerId, sinceMs) {
      return records.filter((record) => record.providerId === providerId && record.atMs >= sinceMs).map((record) => ({ ...record }));
    },
  };
}

/** The share of provider-side attempts that succeeded, or null when there are none (unknown, never 0 or 1). */
export function successRate(records: readonly AttemptRecord[]): number | null {
  const successes = records.filter((record) => record.outcome === "success").length;
  const failures = records.filter((record) => record.outcome === "provider_failure").length;
  const total = successes + failures;
  return total === 0 ? null : successes / total;
}

/** The median latency of successful attempts, or null when none has a latency. */
export function medianLatencyMs(records: readonly AttemptRecord[]): number | null {
  const samples = records
    .filter((record) => record.outcome === "success" && record.latencyMs !== null)
    .map((record) => record.latencyMs as number)
    .sort((a, b) => a - b);
  if (samples.length === 0) return null;
  const middle = Math.floor(samples.length / 2);
  return samples.length % 2 === 1 ? (samples[middle] as number) : ((samples[middle - 1] as number) + (samples[middle] as number)) / 2;
}
