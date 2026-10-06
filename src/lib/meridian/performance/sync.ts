import { acceptPerformanceEvent, type PerformanceEvent } from "./normalize.ts";

export type InsightRow = {
  impressions?: unknown;
  clicks?: unknown;
  spend?: unknown;
  actions?: unknown;
  date_start?: unknown;
};

/** Maps a Meta insights row. Missing numbers stay null and are not written as zero. */
export function metaInsightEvent(input: {
  row: InsightRow;
  creativeId: string;
  externalId: string;
  currency: string;
  timezone: string;
}): PerformanceEvent {
  return {
    externalId: input.externalId,
    creativeId: input.creativeId,
    impressions: count(input.row.impressions),
    reach: null,
    clicks: count(input.row.clicks),
    conversions: conversionCount(input.row.actions),
    spendCents: moneyCents(input.row.spend),
    revenueCents: null,
    currency: input.currency,
    timezone: input.timezone,
    observedOn: typeof input.row.date_start === "string" ? input.row.date_start : "",
  };
}

export function ingestPerformanceRows(existing: PerformanceEvent[], incoming: PerformanceEvent[]): {
  stored: PerformanceEvent[];
  duplicates: number;
  rejected: { externalId: string; detail: string }[];
} {
  const stored: PerformanceEvent[] = [];
  const rejected: { externalId: string; detail: string }[] = [];
  let duplicates = 0;
  let prior = [...existing];
  for (const event of incoming) {
    if (event.impressions == null || event.clicks == null || event.spendCents == null) {
      rejected.push({ externalId: event.externalId, detail: "A missing count was not stored as zero." });
      continue;
    }
    const decision = acceptPerformanceEvent(prior, event);
    if (decision.status === "duplicate") {
      duplicates += 1;
      continue;
    }
    if (decision.status === "rejected" || decision.status === "conflict") {
      rejected.push({ externalId: event.externalId, detail: decision.detail });
      continue;
    }
    stored.push(event);
    prior = [...prior, event];
  }
  return { stored, duplicates, rejected };
}

export function performanceApiImplemented(provider: string): boolean {
  return provider === "meta";
}

function count(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number);
}

function moneyCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

function conversionCount(actions: unknown): number | null {
  if (!Array.isArray(actions)) return null;
  const match = actions.find((row) => row && typeof row === "object" && String((row as { action_type?: string }).action_type || "").includes("conversion"));
  if (!match || typeof match !== "object") return null;
  return count((match as { value?: unknown }).value);
}
