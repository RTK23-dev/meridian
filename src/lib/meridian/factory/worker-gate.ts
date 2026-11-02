// Gating the variants of a factory run: the claim rules, the gate verdicts and the regate entry points. Moved out of
// factory/worker.ts unchanged (coding loop, T5). worker.ts keeps its public names.

import type { Sql } from "../learning/store.ts";
import { combineGates, originalityGate, claimsGate, policyGate, rightsGate, brandGate, type GateVerdict } from "./gates.ts";
import { creativeIdsOfVariant, licencesForCreatives, variantLicenceFlags } from "./rights.ts";
import { loadSavedFactoryPipelineConfig } from "./pipeline-config-store.ts";
import { recordedClaimsOf } from "./template.ts";
import { text } from "./worker-shared.ts";

function splitClaimText(value: string): string[] {
  return value.split(/[\n;]/).map((item) => item.trim()).filter(Boolean);
}

/** The brand's approved claims and prohibited claims, from its product records. Empty when none are recorded. */

async function brandClaimRules(sql: Sql, organizationId: string, brandId: string): Promise<{ approved: string[]; banned: string[] }> {
  const rows = await sql<{ allowed_claims: unknown; prohibited_claims: unknown }>`
    select p.allowed_claims, p.prohibited_claims
    from products p
    join brands b on b.id = p.brand_id
    where b.id = ${brandId} and b.organization_id = ${organizationId} and b.deleted_at is null
  `;
  const approved: string[] = [];
  const banned: string[] = [];
  for (const row of rows) {
    approved.push(...splitClaimText(text(row.allowed_claims)));
    banned.push(...splitClaimText(text(row.prohibited_claims)));
  }
  return { approved, banned };
}

/**
 * The gate verdicts for one variant. Each check gets only the evidence this job has. The claims check gets the brand's
 * approved and prohibited claims and the claim text the variant's storyboard records, so a variant with no recorded claim
 * text is reviewed, not passed.
 */
export function variantGateVerdicts(input: {
  storyboard: string | null;
  rules: { approved: string[]; banned: string[] };
  /** The rights recorded for the variant's creatives: the two licences and the AI-label confirmation (rights.ts). */
  rights: { musicLicensed: boolean; footageLicensed: boolean; aiLabeled: boolean };
  /** A saved line can turn an unapproved claim into review. Omitted means the strict gate, which blocks it. */
  strictClaimGate?: boolean;
}): GateVerdict[] {
  return [
    originalityGate({ frameHashDistance: null, embeddingDistance: null, textSimilarity: null }),
    brandGate({ logoPresent: null, paletteMatch: null, productLooksRight: null }),
    claimsGate({ claims: recordedClaimsOf(input.storyboard ?? ""), approvedClaims: input.rules.approved, bannedWords: input.rules.banned, strict: input.strictClaimGate }),
    // This job runs no policy check, so no flag is known. Unknown is review; it is never recorded as a pass.
    policyGate({ beforeAfter: null, personalAttribute: null, healthClaim: null, financeClaim: null }),
    // The three inputs come from the records for the variant's creatives (rights.ts): the two licences and the AI-label confirmation.
    rightsGate({ musicLicensed: input.rights.musicLicensed, footageLicensed: input.rights.footageLicensed, aiLabeled: input.rights.aiLabeled }),
  ];
}

/**
 * The JEV creative_qa verdict for one variant (NORTH_STAR section 5, gate). The creative questions, the text ones and the visual ones
 * (creative.visual_quality.v1 and creative.product_visible.v1), run once, through the engine gate, when the variant's image is
 * judged at produce. That judgment writes the creative_qa gate record. This stage reads the record and does not ask the engine
 * again, so the engine is paid for once. A variant with no creative, or a creative with no recorded decision, has no evidence and is
 * review. An engine that is not configured, or whose thresholds are not calibrated, routes to review in the record, so it is never a
 * pass here.
 */
export async function creativeQaVerdict(sql: Sql, organizationId: string, brandId: string, variantId: string): Promise<GateVerdict> {
  const rows = await sql<{ creative_id: string; action: string | null }>`
    select fc.creative_id, g.action
    from factory_creatives fc
    left join lateral (
      select d.action from decision_gate_records d
      where d.organization_id = fc.organization_id and d.subject_type = 'creative' and d.subject_id = fc.creative_id
        and d.gate = 'creative_qa'
      order by d.created_at desc
      limit 1
    ) g on true
    -- A carousel is judged through its slides, which are images with their own judgment (produce-carousel.ts). Its carousel row is an
    -- aggregate, so it has no judgment of its own and is left out here; a variant whose carousel has no slides is still review.
    where fc.variant_id = ${variantId} and fc.organization_id = ${organizationId} and fc.brand_id = ${brandId}
      and not (fc.format = 'carousel' and fc.slide_index = -1)
  `;
  if (rows.length === 0) {
    return { gate: "jev", result: "review", reason: "No creative was made for this variant, so the JEV creative check has no evidence." };
  }
  if (rows.some((row) => row.action == null)) {
    return { gate: "jev", result: "review", reason: "The JEV creative check has no recorded decision for a creative of this variant." };
  }
  if (rows.some((row) => row.action === "REJECT")) {
    return { gate: "jev", result: "block", reason: "The JEV creative check rejected a creative of this variant." };
  }
  if (rows.some((row) => row.action !== "AUTO_APPROVE")) {
    return { gate: "jev", result: "review", reason: "The JEV creative check sent a creative of this variant to a person." };
  }
  return { gate: "jev", result: "pass", reason: "The JEV creative check approved every creative of this variant." };
}

/** Gates each recent variant with the rule gates and the JEV creative check, and records the combined result. */

export async function gateVariants(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const rules = await brandClaimRules(sql, organizationId, brandId);
  const variants = await sql<{ id: string; storyboard: string | null }>`
    select v.id, t.storyboard
    from factory_variants v
    left join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where v.organization_id = ${organizationId} and v.brand_id = ${brandId}
    order by v.created_at desc
    limit 40
  `;
  return gateVariantRows(sql, organizationId, brandId, variants, rules);
}

/**
 * Gates the variants that made this creative again. Called when a licence for the creative is attested or revoked, so the stored
 * gate result follows the attestation at once and not at the next gate stage. Returns how many variants were gated.
 */
export async function regateVariantsForCreative(sql: Sql, organizationId: string, brandId: string, creativeId: string): Promise<number> {
  const variants = await sql<{ id: string; storyboard: string | null }>`
    select v.id, t.storyboard
    from factory_creatives fc
    join factory_variants v on v.id = fc.variant_id and v.organization_id = fc.organization_id and v.brand_id = fc.brand_id
    left join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where fc.creative_id = ${creativeId} and fc.organization_id = ${organizationId} and fc.brand_id = ${brandId}
  `;
  if (variants.length === 0) return 0;
  const rules = await brandClaimRules(sql, organizationId, brandId);
  return gateVariantRows(sql, organizationId, brandId, variants, rules);
}

/** Gates one variant again, after its AI label was confirmed or revoked. Returns 1 when the variant exists in this brand, else 0. */

export async function regateVariantById(sql: Sql, organizationId: string, brandId: string, variantId: string): Promise<number> {
  const variants = await sql<{ id: string; storyboard: string | null }>`
    select v.id, t.storyboard
    from factory_variants v
    left join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where v.id = ${variantId} and v.organization_id = ${organizationId} and v.brand_id = ${brandId}
  `;
  if (variants.length === 0) return 0;
  const rules = await brandClaimRules(sql, organizationId, brandId);
  return gateVariantRows(sql, organizationId, brandId, variants, rules);
}

async function gateVariantRows(
  sql: Sql,
  organizationId: string,
  brandId: string,
  variants: Array<{ id: string; storyboard: string | null }>,
  rules: { approved: string[]; banned: string[] },
): Promise<number> {
  const line = await loadSavedFactoryPipelineConfig(sql, organizationId, brandId);
  const strictClaimGate = line?.gradingThresholds.strictClaimGate !== false;
  let count = 0;
  for (const variant of variants) {
    const jev = await creativeQaVerdict(sql, organizationId, brandId, variant.id);
    const creativeIds = await creativeIdsOfVariant(sql, organizationId, brandId, variant.id);
    const licences = await licencesForCreatives(sql, organizationId, brandId, creativeIds);
    const rights = variantLicenceFlags(creativeIds, licences);
    const combined = combineGates([...variantGateVerdicts({ storyboard: variant.storyboard, rules, rights, strictClaimGate }), jev]);
    await sql`
      update factory_variants set gate_result = ${combined.result}
      where id = ${variant.id} and organization_id = ${organizationId} and brand_id = ${brandId}
    `;
    count += 1;
  }
  return count;
}
