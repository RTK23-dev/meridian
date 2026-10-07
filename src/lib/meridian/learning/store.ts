import type { ObservedCreative, PerformanceRow, OrganicObservationRow } from "../domain.ts";
import { learnPatterns } from "./engine.ts";

/** Tagged-template SQL. Structural so the worker does not import the web database module. */
export interface Sql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Recompute brand-scoped patterns from stored rows.
 * Does not mark jobs succeeded. The process that claimed the job records its own result.
 */
export async function applyLearnedPatterns(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const creativeRows = await sql<Record<string, unknown>>`
    select id, organization_id, brand_id, origin, angle, hook_type, format, proof_type, offer, cta,
           visual_style, platform, emotion, product_name, claim, raw_text
    from creative_records
    where brand_id = ${brandId} and organization_id = ${organizationId} and origin <> 'competitor'
  `;
  const observationRows = await sql<Record<string, unknown>>`
    select creative_id, organization_id, brand_id, impressions, clicks, conversions, spend_cents, revenue_cents
    from performance_observations
    where brand_id = ${brandId} and organization_id = ${organizationId}
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
  const observations: PerformanceRow[] = observationRows.map((row) => ({
    creativeId: asText(row.creative_id),
    organizationId: asText(row.organization_id),
    brandId: asText(row.brand_id),
    impressions: asNumber(row.impressions),
    clicks: asNumber(row.clicks),
    conversions: asNumber(row.conversions),
    spendCents: asNumber(row.spend_cents),
    revenueCents: row.revenue_cents == null ? null : asNumber(row.revenue_cents),
  }));
  let organicObservations: OrganicObservationRow[] = [];
  try {
    const organicRows = await sql<Record<string, unknown>>`
      select creative_id, organization_id, brand_id, views, three_second_views, completion_rate, shares, likes, comments
      from organic_observations
      where brand_id = ${brandId} and organization_id = ${organizationId} and creative_id is not null
    `;
    organicObservations = organicRows.map((row) => ({
      creativeId: asText(row.creative_id),
      organizationId: asText(row.organization_id),
      brandId: asText(row.brand_id),
      views: asNumber(row.views),
      threeSecondViews: asNumber(row.three_second_views),
      completionRate: asNumber(row.completion_rate),
      shares: asNumber(row.shares),
      likes: asNumber(row.likes),
      comments: asNumber(row.comments),
    }));
  } catch {
    organicObservations = [];
  }
  const patterns = learnPatterns({ organizationId, brandId, creatives, observations, organicObservations });
  await sql`delete from learned_patterns where brand_id = ${brandId} and organization_id = ${organizationId} and scope = 'brand'`;
  for (const pattern of patterns) {
    await sql`
      insert into learned_patterns (
        id, organization_id, brand_id, attribute, value, metric, lift, sample_size, baseline, observed, impressions, summary,
        state, clicks, conversions, spend_cents, revenue_cents, scope, p_beat, ci_low, ci_high, q_value
      ) values (
        ${globalThis.crypto.randomUUID()}, ${organizationId}, ${brandId}, ${pattern.attribute}, ${pattern.value}, ${pattern.metric},
        ${pattern.lift}, ${pattern.sampleSize}, ${pattern.baseline}, ${pattern.observed}, ${pattern.impressions}, ${pattern.summary},
        ${pattern.state ?? "INFERRED"}, ${pattern.clicks ?? 0}, ${pattern.conversions ?? 0}, ${pattern.spendCents ?? 0}, ${pattern.revenueCents ?? 0},
        ${pattern.scope ?? "brand"}, ${pattern.pBeat ?? null}, ${pattern.ciLow ?? null}, ${pattern.ciHigh ?? null}, ${pattern.qValue ?? null}
      )
    `;
  }
  return patterns.length;
}
