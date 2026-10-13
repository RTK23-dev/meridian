import type { LearnedPattern, LearningSurface, ObservedCreative, PerformanceRow, OrganicObservationRow } from "../domain.ts";
import { learnPatterns } from "./engine.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

/**
 * Tagged-template SQL. Structural so the worker does not import the web database module.
 * `begin` is optional here because the worker's client may not provide transactions; code that needs one calls
 * `withTransaction`, which refuses to run without a real transaction instead of compensating for a missing one.
 */
export interface Sql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  begin?<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

/** Runs `fn` in one real transaction, or throws when the connection cannot provide one. Never simulated. */
export async function withTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!sql.begin) throw new Error("This database connection cannot run a transaction, so the operation was not started.");
  return sql.begin(fn);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** What one recomputation stored, per surface: the patterns kept, and the measured outcomes they were learned from. */
export type LearningSummary = {
  patterns: number;
  bySurface: Record<LearningSurface, { patterns: number; outcomes: number }>;
};

/**
 * Recompute brand-scoped patterns from stored rows, per surface and channel (NORTH_STAR section 8, item 10).
 * Does not mark jobs succeeded. The process that claimed the job records its own result.
 */
export async function applyLearnedPatternsBySurface(sql: Sql, organizationId: string, brandId: string): Promise<LearningSummary> {
  const creativeRows = await sql<Record<string, unknown>>`
    select id, organization_id, brand_id, origin, angle, hook_type, format, proof_type, offer, cta,
           visual_style, platform, emotion, product_name, claim, raw_text
    from creative_records
    where brand_id = ${brandId} and organization_id = ${organizationId} and origin <> 'competitor'
  `;
  // Test-source rows (simulated performance) never train production learning. In the testing runtime, where the whole
  // loop is simulated end to end, they are the learning input, so they are kept there.
  const includeTestSources = isTestingRuntimeNow();
  const observationRows = await sql<Record<string, unknown>>`
    select creative_id, organization_id, brand_id, impressions, clicks, conversions, spend_cents, revenue_cents, platform
    from performance_observations
    where brand_id = ${brandId} and organization_id = ${organizationId}
      and (${includeTestSources}::boolean or source not like 'test:%')
  `;
  const creatives: ObservedCreative[] = creativeRows.map((row) => ({
    id: asText(row.id),
    organizationId: asText(row.organization_id),
    brandId: asText(row.brand_id),
    origin: asText(row.origin) as ObservedCreative["origin"],
    angle: asText(row.angle),
    hookType: asText(row.hook_type),
    format: asText(row.format),
    proofType: asText(row.proof_type),
    offer: asText(row.offer),
    cta: asText(row.cta),
    visualStyle: asText(row.visual_style),
    platform: asText(row.platform),
    emotion: asText(row.emotion),
    productName: asText(row.product_name),
    claim: asText(row.claim),
    text: asText(row.raw_text),
  }));
  // A row with an unreported paid metric cannot give a rate, so it does not train learning. Unknown is never read as zero.
  const observations: PerformanceRow[] = observationRows
    .filter((row) => row.impressions != null && row.clicks != null && row.conversions != null && row.spend_cents != null)
    .map((row) => ({
    creativeId: asText(row.creative_id),
    organizationId: asText(row.organization_id),
    brandId: asText(row.brand_id),
    impressions: asNumber(row.impressions),
    clicks: asNumber(row.clicks),
    conversions: asNumber(row.conversions),
    spendCents: asNumber(row.spend_cents),
    revenueCents: row.revenue_cents == null ? null : asNumber(row.revenue_cents),
    channel: asText(row.platform),
  }));
  let organicObservations: OrganicObservationRow[] = [];
  try {
    const organicRows = await sql<Record<string, unknown>>`
      select creative_id, organization_id, brand_id, platform, views, three_second_views, completion_rate, shares, likes, comments
      from organic_observations
      where brand_id = ${brandId} and organization_id = ${organizationId} and creative_id is not null
    `;
    organicObservations = organicRows.map((row) => ({
      creativeId: asText(row.creative_id),
      organizationId: asText(row.organization_id),
      brandId: asText(row.brand_id),
      channel: asText(row.platform),
      views: optionalNumber(row.views),
      threeSecondViews: optionalNumber(row.three_second_views),
      completionRate: optionalNumber(row.completion_rate),
      shares: optionalNumber(row.shares),
      likes: optionalNumber(row.likes),
      comments: optionalNumber(row.comments),
    }));
  } catch {
    organicObservations = [];
  }
  // Learned once over every channel (channel ''), and once per channel that a row names. A channel set holds only its own rows, so a
  // pattern for one platform never comes from another platform's outcomes. Paid and organic metrics are disjoint, so each call
  // learns each surface from its own rows only.
  const channels = [...new Set([...observations, ...organicObservations].map((row) => row.channel ?? "").filter(Boolean))].sort();
  const patterns: LearnedPattern[] = [];
  for (const channel of ["", ...channels]) {
    const set = learnPatterns({
      organizationId,
      brandId,
      creatives,
      observations: observations.filter((row) => channel === "" || (row.channel ?? "") === channel),
      organicObservations: organicObservations.filter((row) => channel === "" || (row.channel ?? "") === channel),
    });
    for (const pattern of set) patterns.push({ ...pattern, channel });
  }
  const bySurface: Record<LearningSurface, { patterns: number; outcomes: number }> = {
    organic: {
      patterns: patterns.filter((pattern) => pattern.surface === "organic").length,
      outcomes: organicObservations.filter(hasOrganicMetric).length,
    },
    paid: {
      patterns: patterns.filter((pattern) => pattern.surface === "paid").length,
      outcomes: observations.length,
    },
  };
  // Read, compute, then replace in one transaction. A failed insert rolls the delete back, so readers never see an empty
  // or half-written set. The advisory lock serializes two replacements for the same brand: without it, both would delete
  // the old rows and both would insert, leaving duplicates.
  await withTransaction(sql, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`learned_patterns:${organizationId}:${brandId}`}))`;
    await tx`delete from learned_patterns where brand_id = ${brandId} and organization_id = ${organizationId} and scope = 'brand'`;
    for (const pattern of patterns) {
      // A pattern with no surface cannot be kept apart from another surface's, so it is not stored.
      if (!pattern.surface) continue;
      await tx`
        insert into learned_patterns (
          id, organization_id, brand_id, attribute, value, metric, lift, sample_size, baseline, observed, impressions, summary,
          state, clicks, conversions, spend_cents, revenue_cents, scope, p_beat, ci_low, ci_high, q_value, surface, channel
        ) values (
          ${globalThis.crypto.randomUUID()}, ${organizationId}, ${brandId}, ${pattern.attribute}, ${pattern.value}, ${pattern.metric},
          ${pattern.lift}, ${pattern.sampleSize}, ${pattern.baseline}, ${pattern.observed}, ${pattern.impressions}, ${pattern.summary},
          ${pattern.state ?? "INFERRED"}, ${pattern.clicks ?? 0}, ${pattern.conversions ?? 0}, ${pattern.spendCents ?? 0}, ${pattern.revenueCents ?? 0},
          ${pattern.scope ?? "brand"}, ${pattern.pBeat ?? null}, ${pattern.ciLow ?? null}, ${pattern.ciHigh ?? null}, ${pattern.qValue ?? null},
          ${pattern.surface}, ${pattern.channel ?? ""}
        )
      `;
    }
  });
  return { patterns: patterns.length, bySurface };
}

/** The number of patterns stored, across both surfaces. Callers that do not report per surface use this. */
export async function applyLearnedPatterns(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  return (await applyLearnedPatternsBySurface(sql, organizationId, brandId)).patterns;
}

/** Whether an organic observation carries at least one measured organic metric. An all-unknown row is not an outcome. */
function hasOrganicMetric(row: OrganicObservationRow): boolean {
  return row.views != null || row.threeSecondViews != null || row.completionRate != null || row.shares != null;
}
