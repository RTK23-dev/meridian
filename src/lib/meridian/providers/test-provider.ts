import type { PerformanceEvent } from "../performance/normalize.ts";

/** Explicit test double. Production callers must pass allowTestProvider. Ids are prefixed test:. */
export function testProviderPublish(creativeId: string, allowTestProvider: boolean): { externalId: string; mode: "test" } {
  if (!allowTestProvider) throw new Error("The test publishing provider is not enabled.");
  if (!creativeId.trim()) throw new Error("The test provider needs a creative id.");
  return { externalId: `test:${creativeId}`, mode: "test" };
}

export function testProviderPerformance(creativeId: string, allowTestProvider: boolean): PerformanceEvent {
  if (!allowTestProvider) throw new Error("The test performance provider is not enabled.");
  return {
    externalId: `test:${creativeId}:day`,
    creativeId,
    impressions: 1000,
    reach: 800,
    clicks: 40,
    conversions: 4,
    spendCents: 2000,
    revenueCents: 8000,
    currency: "USD",
    timezone: "UTC",
    observedOn: "2026-01-01",
  };
}
