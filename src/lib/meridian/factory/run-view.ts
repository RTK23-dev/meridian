/**
 * The run view of the Factory board (NORTH_STAR section 8, item 11). For each run it lists the concepts the run picked, each with the
 * JEV prediction it was made under and its status, and the variants each pick produced, with the attribute each variant tests and the
 * creatives those variants became. The board reads the receipts and the measured rows of those creatives from the same publishing
 * rows it already loads, so each measurement is read once and shown with the variant it belongs to.
 *
 * Every read is scoped to one workspace and one brand. A run id that belongs to another brand returns nothing.
 */

import type { Sql } from "../learning/store.ts";
import { predictionOf, predictionStatusOf, type GradeRecord, type PredictionStatus, type PredictionView } from "./prediction.ts";
import { licencesForCreatives, variantRightsView, type VariantRights } from "./rights.ts";

/** One variant of a pick. `attribute` is the one attribute the variant changes against its control: '' for a row from before that. */
export type RunVariantView = {
  id: string;
  attribute: string;
  hook: string;
  angle: string;
  format: string;
  proof: string;
  cta: string;
  gateResult: string;
  /** The creatives this variant produced, one per format. Empty while the variant is not produced. */
  creatives: Array<{ creativeId: string; format: string }>;
  /** The rights gate's state: what blocks the variant, and each creative's attested licences. */
  rights: VariantRights;
};

export type RunPickView = {
  id: string;
  concept: string;
  researchAdId: string;
  score: number;
  /** The surface whose learned pattern weighted the pick, or '' for a run that learned from none. */
  surface: string;
  /** The grade the ad carries now, as a prediction: an engine answer, observed only, or not graded. */
  prediction: PredictionView;
  /** Whether the grade is the one the pick was made under, or the ad was graded again, or the pick predates the record. */
  predictionStatus: PredictionStatus;
  /** planned: a CreativePlan exists; not_planned: the plan was refused, with the reason; no_storyboard: the pick has no storyboard yet. */
  plan: "planned" | "not_planned" | "no_storyboard";
  planReason: string;
  variants: RunVariantView[];
};

export type RunView = { picks: RunPickView[] };

type PickRow = {
  id: string;
  run_id: string;
  concept: string;
  research_ad_id: string;
  score: number;
  surface: string;
  grade_fingerprint: string;
  template_id: string | null;
  plan: string | null;
  jev_status: string | null;
  jev_action: string | null;
  jev_reason: string | null;
  jev_engine_id: string | null;
  jev_model: string | null;
  jev_question_versions: string | null;
  jev_policy_version: string | null;
  jev_gate_record_id: string | null;
};

type VariantRow = {
  run_id: string;
  research_ad_id: string;
  id: string;
  tests_attribute: string;
  hook: string;
  angle: string;
  format: string;
  proof: string;
  cta: string;
  gate_result: string;
  creative_id: string | null;
  creative_format: string | null;
};

/** The grade an ad carries, or null when it was never graded. Nothing is filled in for a column the row does not hold. */
function gradeOf(row: PickRow): GradeRecord | null {
  if (row.jev_status == null) return null;
  return {
    jev_status: row.jev_status,
    jev_action: row.jev_action,
    jev_reason: row.jev_reason ?? "",
    jev_engine_id: row.jev_engine_id,
    jev_model: row.jev_model,
    jev_question_versions: row.jev_question_versions ?? "[]",
    jev_policy_version: row.jev_policy_version ?? "",
    jev_gate_record_id: row.jev_gate_record_id,
  };
}

/**
 * The run views of the given runs of one brand, keyed by run id. Each run that belongs to the brand has an entry, even with no picks.
 * A run of another brand or workspace is not in the result.
 */
export async function factoryRunViewsFor(
  sql: Sql,
  scope: { organizationId: string; brandId: string },
  runIds: readonly string[],
): Promise<Map<string, RunView>> {
  const views = new Map<string, RunView>();
  for (const runId of runIds) views.set(runId, { picks: [] });
  if (runIds.length === 0) return views;
  const ids = [...runIds];

  // A pick's storyboard is the template its run wrote for the pick's ad: `tpl:<run>:<ad>` (worker.ts persistTemplates).
  const picks = await sql<PickRow>`
    select p.id, p.run_id, p.concept, p.research_ad_id, p.score, p.surface, p.grade_fingerprint,
      tp.id as template_id, tp.plan,
      t.jev_status, t.jev_action, t.jev_reason, t.jev_engine_id, t.jev_model, t.jev_question_versions, t.jev_policy_version,
      t.jev_gate_record_id
    from factory_picks p
    left join ad_timelines t
      on t.research_ad_id = p.research_ad_id and t.organization_id = p.organization_id and t.brand_id = p.brand_id
    left join factory_templates tp
      on tp.id = ('tpl:' || p.run_id || ':' || p.research_ad_id) and tp.organization_id = p.organization_id and tp.brand_id = p.brand_id
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId} and p.run_id = any(${ids})
    order by p.score desc, p.id
  `;

  const pickByKey = new Map<string, RunPickView>();
  for (const row of picks) {
    const grade = gradeOf(row);
    const hasPlan = (row.plan ?? "") !== "";
    const plan: RunPickView["plan"] = row.template_id == null ? "no_storyboard" : hasPlan ? "planned" : "not_planned";
    // A refused plan names the grade's own reason, as the run records it (worker.ts persistTemplates).
    let planReason = "";
    if (plan === "not_planned") planReason = row.jev_reason || "no engine decision backs this ad";
    if (plan === "no_storyboard") planReason = "No storyboard is stored for this pick yet.";
    const pick: RunPickView = {
      id: row.id,
      concept: row.concept,
      researchAdId: row.research_ad_id,
      score: Number(row.score),
      surface: row.surface,
      prediction: predictionOf(grade),
      predictionStatus: predictionStatusOf(row.grade_fingerprint, grade),
      plan,
      planReason,
      variants: [],
    };
    pickByKey.set(`${row.run_id}|${row.research_ad_id}`, pick);
    views.get(row.run_id)?.picks.push(pick);
  }

  const variants = await sql<VariantRow>`
    select p.run_id, p.research_ad_id, v.id, v.tests_attribute, v.hook, v.angle, v.format, v.proof, v.cta, v.gate_result,
      c.creative_id, c.format as creative_format
    from factory_picks p
    join factory_templates tp
      on tp.id = ('tpl:' || p.run_id || ':' || p.research_ad_id) and tp.organization_id = p.organization_id and tp.brand_id = p.brand_id
    join factory_variants v on v.template_id = tp.id and v.organization_id = p.organization_id and v.brand_id = p.brand_id
    left join factory_creatives c on c.variant_id = v.id
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId} and p.run_id = any(${ids})
    order by p.run_id, v.id, c.format
  `;

  const variantById = new Map<string, RunVariantView>();
  for (const row of variants) {
    const pick = pickByKey.get(`${row.run_id}|${row.research_ad_id}`);
    if (!pick) continue;
    let variant = variantById.get(row.id);
    if (!variant) {
      variant = {
        id: row.id,
        attribute: row.tests_attribute,
        hook: row.hook,
        angle: row.angle,
        format: row.format,
        proof: row.proof,
        cta: row.cta,
        gateResult: row.gate_result,
        creatives: [],
        rights: { blockedBy: null, creatives: [] },
      };
      variantById.set(row.id, variant);
      pick.variants.push(variant);
    }
    if (row.creative_id) variant.creatives.push({ creativeId: row.creative_id, format: row.creative_format ?? "" });
  }
  // The attested licences of every creative on the board are read once, and each variant's rights state is computed from them.
  const creativeIds = [...new Set([...variantById.values()].flatMap((variant) => variant.creatives.map((item) => item.creativeId)))];
  const licences = await licencesForCreatives(sql, scope.organizationId, scope.brandId, creativeIds);
  for (const variant of variantById.values()) {
    variant.rights = variantRightsView(variant.creatives.map((item) => item.creativeId), licences);
  }
  return views;
}
