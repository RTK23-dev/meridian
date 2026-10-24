// The decision checks on a repurposed video. Meridian's decision engine judges the treatments against the brand's stated positioning,
// through the gate (decisions/gate.ts), which records its calls and its outcome. There are two checks. The plan check is one engine call for
// the whole plan, made when the run is planned. The variant check is one call for each rendered variation, made when that variation is
// rendered. Neither engine call sees pixels: each judges the treatment names. Its probability is not calibrated, so its outcome is advisory.
// A workspace with no decision engine records a check as not consulted, and the deterministic work goes ahead.

import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { runEngineGate, type GateInput, type GateResult } from "../decisions/gate.ts";
import type { JevQuestionSpec } from "../jev/types.ts";
import type { Sql } from "../learning/store.ts";
import type { RepurposedVariation } from "../../../engine/repurpose/resolve.ts";

const CRITERIA = {
  true: "The treatments leave the message, product and brand tone of the master as they are.",
  false: "The treatments change the message, hide the product, or work against the brand's stated tone.",
};
const POLICY = { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const;

export const REPURPOSE_PLAN_QUESTION: JevQuestionSpec = {
  id: "repurpose.plan_brand_fit.v1",
  version: "1.0.0",
  type: "noul",
  instructions:
    "Would these visual treatments, applied to the delivered master video, leave its message, its product and the brand's stated tone as they are? Judge how the treatments change the way the video reads for the brand, not whether they are attractive.",
  criteria: CRITERIA,
  evidenceRequirements: ["treatment_plan"],
  policyMapping: POLICY,
};

/** The question each rendered variation is judged on. It reads the treatment names, so it says nothing about the rendered pixels. */
export const REPURPOSE_VARIANT_QUESTION: JevQuestionSpec = {
  id: "repurpose.variant_brand_fit.v1",
  version: "1.0.0",
  type: "noul",
  instructions:
    "Would this rendered variation, made from the delivered master video with these visual treatments, leave its message, its product and the brand's stated tone as they are? The treatment names are the only evidence. Judge how they change the way the video reads for the brand, not whether they are attractive.",
  criteria: CRITERIA,
  evidenceRequirements: ["variant_treatments"],
  policyMapping: POLICY,
};

const PLAN_SCOPE = "treatment_plan";
const VARIANT_SCOPE = "variant_treatments";
const NO_BRAND = "The session has no brand, so the decision check is not consulted.";

export type RepurposeCheck = {
  outcome: "approved" | "review" | "rejected" | "not_consulted";
  reason: string;
  engineId: string | null;
  gateRecordId: string | null;
};

/** The plan as the engine reads it: one line per variation, naming each treatment and its label. Deterministic: the same plan, the same text. */
export function planTextOf(variations: readonly RepurposedVariation[]): string {
  return variations
    .map((variation) => `Variation ${variation.index + 1}: ${variation.treatments.map((treatment) => treatment.label).join(" · ")}`)
    .join("\n");
}

/**
 * The check's outcome from the gate's result. No engine answered (none connected, or the one selected cannot be reached) is not a
 * judgement, so nothing is recorded as approved, reviewed or rejected. Uncalibrated scores stay under review (policy: scores are scores
 * until a calibration report says otherwise), so an approval or a rejection needs a calibration for the question.
 */
function checkOf(result: GateResult): RepurposeCheck {
  if (!result.engineCalled || result.failureKind === "not_configured" || result.failureKind === "selection_unavailable") {
    return { outcome: "not_consulted", reason: result.reason, engineId: null, gateRecordId: result.gateRecordId };
  }
  const outcome = result.action === "AUTO_APPROVE" ? "approved" : result.action === "REJECT" ? "rejected" : "review";
  return { outcome, reason: result.reason, engineId: result.engineId, gateRecordId: result.gateRecordId };
}

export async function judgeRepurposePlan(input: {
  sql: Sql;
  organizationId: string;
  brandId: string | null;
  subjectId: string;
  variations: readonly RepurposedVariation[];
  selection?: GateInput["selection"];
  engines?: DecisionEngineRegistry;
}): Promise<RepurposeCheck> {
  if (input.brandId === null) return { outcome: "not_consulted", reason: NO_BRAND, engineId: null, gateRecordId: null };
  const result = await runEngineGate({
    sql: input.sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "repurpose",
    subject: { type: "repurpose_plan", id: input.subjectId },
    description: "A visual treatment plan for repurposing one delivered video. Judge only the plan's treatments, against the brand.",
    questions: [{ key: REPURPOSE_PLAN_QUESTION.id, spec: REPURPOSE_PLAN_QUESTION, needsImage: false, evidenceScope: [PLAN_SCOPE] }],
    evidence: [{ kind: "text", name: PLAN_SCOPE, content: planTextOf(input.variations) }],
    selection: input.selection,
    engines: input.engines,
  });
  return checkOf(result);
}

/**
 * The check on one rendered variation. Its subject is the rendered video, so a variation rendered again is judged again. Its outcome is
 * advisory: it is shown to the reviewer and blocks nothing.
 */
export async function judgeRepurposeVariant(input: {
  sql: Sql;
  organizationId: string;
  brandId: string | null;
  subjectId: string;
  treatments: readonly string[];
  selection?: GateInput["selection"];
  engines?: DecisionEngineRegistry;
}): Promise<RepurposeCheck> {
  if (input.brandId === null) return { outcome: "not_consulted", reason: NO_BRAND, engineId: null, gateRecordId: null };
  const result = await runEngineGate({
    sql: input.sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "repurpose_variant",
    subject: { type: "repurpose_variant", id: input.subjectId },
    description: "One rendered variation of a delivered video. Judge only the treatments it applies, against the brand. The rendered pixels are not seen.",
    questions: [{ key: REPURPOSE_VARIANT_QUESTION.id, spec: REPURPOSE_VARIANT_QUESTION, needsImage: false, evidenceScope: [VARIANT_SCOPE] }],
    evidence: [{ kind: "text", name: VARIANT_SCOPE, content: `Treatments: ${input.treatments.join(" · ")}` }],
    selection: input.selection,
    engines: input.engines,
  });
  return checkOf(result);
}
