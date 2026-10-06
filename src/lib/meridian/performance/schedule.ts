import type { ConnectionPhase } from "../providers/phase.ts";

/** A healthy Meta, TikTok, or Google connection can be scheduled. The scheduler only enqueues. */
export function performanceScheduleDecision(input: {
  provider: string;
  phase: ConnectionPhase;
  disconnected: boolean;
}): { enabled: boolean; reason: string } {
  if (input.disconnected) return { enabled: false, reason: "A disconnected provider is not scheduled." };
  if (input.provider !== "meta" && input.provider !== "tiktok" && input.provider !== "google") {
    return { enabled: false, reason: "This provider has no performance client, so it is not scheduled." };
  }
  if (input.phase !== "HEALTHY" && input.phase !== "CONNECTED") {
    return { enabled: false, reason: "Performance sync waits for a successful provider request." };
  }
  return { enabled: true, reason: "Enqueue performance.sync on the cadence. The web process does not run it." };
}

export function performanceScheduleId(organizationId: string, brandId: string, provider: string): string {
  return `perf:${organizationId}:${brandId}:${provider}`;
}

export type PerformanceSchedulePlan = {
  id: string;
  organizationId: string;
  brandId: string;
  jobType: "performance.sync";
  everySeconds: number;
  enabled: boolean;
  payload: {
    provider: string;
    organizationId: string;
    creativeId: string;
    externalAdId: string;
    currency: string;
    timezone: string;
    startDate: string;
    endDate: string;
  };
  reason: string;
};

/** One row per workspace, brand, and provider. A retry updates that row. It does not add another. */
export function planPerformanceSchedule(input: {
  organizationId: string;
  brandId: string;
  provider: string;
  phase: ConnectionPhase;
  disconnected: boolean;
  everySeconds: number;
  creativeId: string;
  externalAdId: string;
  currency: string;
  timezone: string;
  startDate: string;
  endDate: string;
}): PerformanceSchedulePlan | { error: string } {
  if (!input.organizationId.trim() || !input.brandId.trim()) return { error: "A schedule needs a workspace and a brand." };
  if (!input.creativeId.trim() || !input.externalAdId.trim() || !input.currency.trim() || !input.timezone.trim()) {
    return { error: "A performance schedule needs a creative, an external ad id, a currency, and a timezone." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return { error: "The date range must be YYYY-MM-DD. Nothing was scheduled." };
  }
  if (!Number.isFinite(input.everySeconds) || input.everySeconds < 30) {
    return { error: "Cadence must be at least 30 seconds." };
  }
  const decision = performanceScheduleDecision(input);
  return {
    id: performanceScheduleId(input.organizationId, input.brandId, input.provider),
    organizationId: input.organizationId,
    brandId: input.brandId,
    jobType: "performance.sync",
    everySeconds: Math.floor(input.everySeconds),
    enabled: decision.enabled,
    payload: {
      provider: input.provider,
      organizationId: input.organizationId,
      creativeId: input.creativeId.trim(),
      externalAdId: input.externalAdId.trim(),
      currency: input.currency.trim(),
      timezone: input.timezone.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
    },
    reason: decision.reason,
  };
}