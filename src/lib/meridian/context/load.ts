import { emptyBrain, BRAIN_FIELDS } from "../brain.ts";
import type { BrainSlice, LearnedPattern, ObservedCreative, ProductFact, RejectionFact } from "../domain.ts";
import type { ScoreWeights } from "../scoring.ts";
import { weightsFromUnknown } from "../scoring.ts";
import type { Sql } from "../learning/store.ts";

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sliceFromRow(row: Record<string, unknown> | undefined): BrainSlice {
  const brain = emptyBrain();
  if (row) {
    for (const field of BRAIN_FIELDS) brain[field.key] = asText(row[field.column]);
  }
  return {
    positioning: brain.positioning,
    differentiators: brain.differentiators,
    problems: brain.problems,
    desires: brain.desires,
    objections: brain.objections,
    tone: brain.tone,
    wordsToAvoid: brain.wordsToAvoid,
    preferredFormats: brain.preferredFormats,
    prohibitedClaims: brain.prohibitedClaims,
    requiredDisclaimers: brain.requiredDisclaimers,
    targetCustomers: brain.targetCustomers,
    valueProposition: brain.valueProposition,
  };
}

export type BrandContext = {
  brain: BrainSlice;
  products: ProductFact[];
  creatives: ObservedCreative[];
  patterns: LearnedPattern[];
  rejections: RejectionFact[];
  weights: ScoreWeights;
  useOrganizationLearning: boolean;
};

/** Brand rows for ranking. Relative imports only, so the worker can load it. */
export async function loadBrandContext(sql: Sql, organizationId: string, brandId: string): Promise<BrandContext> {
  const brainRows = await sql.query<Record<string, unknown>>(
    `select ${BRAIN_FIELDS.map((field) => field.column).join(", ")} from brand_brains where brand_id = $1 limit 1`,
    [brandId],
  );
  const productRows = await sql<Record<string, unknown>>`
    select id, name, description, allowed_claims, prohibited_claims
    from products where brand_id = ${brandId} and deleted_at is null order by created_at asc
  `;
  const creativeRows = await sql<Record<string, unknown>>`
    select id, organization_id, brand_id, origin, angle, hook_type, format, proof_type, offer, cta,
           visual_style, platform, emotion, product_name, claim, raw_text
    from creative_records where brand_id = ${brandId} and organization_id = ${organizationId}
  `;
  const patternRows = await sql<Record<string, unknown>>`
    select organization_id, brand_id, attribute, value, metric, lift, sample_size, baseline, observed, impressions, summary, state, clicks, conversions, spend_cents, revenue_cents, scope
    from learned_patterns
    where organization_id = ${organizationId} and (brand_id = ${brandId} or scope = 'organization')
  `;
  const rejectionRows = await sql<{ reason_code: string; count: number }>`
    select reason_code, count(*) as count from rejections
    where brand_id = ${brandId} and organization_id = ${organizationId}
    group by reason_code
  `;
  const settingRows = await sql<Record<string, unknown>>`
    select use_organization_learning from brand_brains where brand_id = ${brandId} limit 1
  `;
  const flag = settingRows[0]?.use_organization_learning;
  const patterns: LearnedPattern[] = patternRows.map((row) => ({
    attribute: asText(row.attribute),
    value: asText(row.value),
    metric: asText(row.metric) as LearnedPattern["metric"],
    lift: asNumber(row.lift),
    sampleSize: asNumber(row.sample_size),
    baseline: asNumber(row.baseline),
    observed: asNumber(row.observed),
    impressions: asNumber(row.impressions),
    summary: asText(row.summary),
    state: asText(row.state) === "VALIDATED" || asText(row.state) === "OBSERVED" ? (asText(row.state) as LearnedPattern["state"]) : "INFERRED",
    clicks: asNumber(row.clicks),
    conversions: asNumber(row.conversions),
    spendCents: asNumber(row.spend_cents),
    revenueCents: asNumber(row.revenue_cents),
    organizationId: asText(row.organization_id) || organizationId,
    brandId: asText(row.brand_id) || brandId,
    scope: asText(row.scope) === "global" || asText(row.scope) === "organization" ? (asText(row.scope) as LearnedPattern["scope"]) : "brand",
  }));
  return {
    brain: sliceFromRow(brainRows[0]),
    products: productRows.map((row) => ({
      id: asText(row.id),
      name: asText(row.name),
      description: asText(row.description),
      allowedClaims: asText(row.allowed_claims),
      prohibitedClaims: asText(row.prohibited_claims),
    })),
    creatives: creativeRows.map((row) => ({
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
    })),
    patterns,
    rejections: rejectionRows.map((row) => ({ reasonCode: row.reason_code, count: asNumber(row.count) })),
    weights: weightsFromUnknown((await sql<Record<string, unknown>>`
      select brand_fit, historical_evidence, market_signal, novelty, reproducibility, saturation, risk
      from organizations where id = ${organizationId} limit 1
    `)[0]),
    useOrganizationLearning: flag === true || flag === "t" || flag === "true",
  };
}
