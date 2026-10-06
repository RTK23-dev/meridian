export type PerformanceEvent = {
  externalId: string;
  creativeId: string;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  conversions: number | null;
  spendCents: number | null;
  revenueCents: number | null;
  currency: string;
  timezone: string;
  observedOn: string;
};

export type PerformanceDecision =
  | { status: "stored"; metrics: ReturnType<typeof rates> }
  | { status: "duplicate" }
  | { status: "conflict"; detail: string }
  | { status: "rejected"; detail: string };

function rates(event: PerformanceEvent) {
  return {
    ctr: ratio(event.clicks, event.impressions),
    cvr: ratio(event.conversions, event.clicks),
    roas: ratio(event.revenueCents, event.spendCents),
    cpcCents: event.clicks && event.spendCents != null && event.clicks > 0 ? Math.round(event.spendCents / event.clicks) : null,
    cpmCents: event.impressions && event.spendCents != null && event.impressions > 0 ? Math.round((event.spendCents / event.impressions) * 1000) : null,
    cpaCents: event.conversions && event.spendCents != null && event.conversions > 0 ? Math.round(event.spendCents / event.conversions) : null,
  };
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return numerator / denominator;
}

function negative(event: PerformanceEvent): boolean {
  return [event.impressions, event.reach, event.clicks, event.conversions, event.spendCents, event.revenueCents].some(
    (value) => value != null && value < 0,
  );
}

/** Manual and provider rows share this gate. Missing denominators stay null. */
export function acceptPerformanceEvent(existing: PerformanceEvent[], incoming: PerformanceEvent): PerformanceDecision {
  if (!incoming.creativeId.trim()) return { status: "rejected", detail: "Performance needs a creative." };
  if (!incoming.observedOn.trim()) return { status: "rejected", detail: "Performance needs an observation date." };
  if ((incoming.spendCents != null || incoming.revenueCents != null) && !incoming.currency.trim()) {
    return { status: "rejected", detail: "Spend or revenue needs a currency." };
  }
  if (!incoming.timezone.trim()) return { status: "rejected", detail: "Performance needs a timezone. The date was not guessed." };
  if (negative(incoming)) return { status: "rejected", detail: "Negative counts are not stored." };
  const prior = existing.find((event) => event.externalId && event.externalId === incoming.externalId);
  if (prior) {
    const same = JSON.stringify(prior) === JSON.stringify(incoming);
    return same ? { status: "duplicate" } : { status: "conflict", detail: "The same external id arrived with different numbers." };
  }
  return { status: "stored", metrics: rates(incoming) };
}
