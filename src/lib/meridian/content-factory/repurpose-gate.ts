// The decision check on a repurpose plan. Meridian's decision engine judges the plan's treatments against the brand's stated positioning,
// through the gate (decisions/gate.ts), which records its calls and its outcome. It is one engine call for the whole plan: the treatments
// themselves are deterministic and need no AI call per variation. The check judges the plan's text. It has not seen the rendered video, so
// it says nothing about pixels, and its probability is not calibrated. A workspace with no decision engine records the check as not
// consulted, and the deterministic plan goes ahead.

import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { runEngineGate, type GateInput } from "../decisions/gate.ts";
import type { JevQuestionSpec } from "../jev/types.ts";
import type { Sql } from "../learning/store.ts";
import type { RepurposedVariation } from "../../../engine/repurpose/resolve.ts";

export const REPURPOSE_PLAN_QUESTION: JevQuestionSpec = {
  id: "repurpose.plan_brand_fit.v1",
  version: "1.0.0",
  type: "noul",
  instructions:
    "Would these visual treatments, applied to the delivered master video, leave its message, its product and the brand's stated tone as they are? Judge how the treatments change the way the video reads for the brand, not whether they are attractive.",
  criteria: {
    true: "The treatments leave the message, product and brand tone of the master as they are.",
    false: "The treatments change the message, hide the product, or work against the brand's stated tone.",
  },
  evidenceRequirements: ["treatment_plan"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};

const PLAN_SCOPE = "treatment_plan";

export type RepurposePlanCheck = {
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

export async function judgeRepurposePlan(input: {
  sql: Sql;
  organizationId: string;
  brandId: string | null;
  subjectId: string;
  variations: readonly RepurposedVariation[];
  selection?: GateInput["selection"];
  engines?: DecisionEngineRegistry;
}): Promise<RepurposePlanCheck> {
  if (input.brandId === null) {
    return { outcome: "not_consulted", reason: "The session has no brand, so the decision check is not consulted.", engineId: null, gateRecordId: null };
  }
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
  // No engine answered: none is connected for the workspace, or the one selected cannot be reached. That is not a judgement, so nothing is
  // recorded as approved, reviewed or rejected.
  if (!result.engineCalled || result.failureKind === "not_configured" || result.failureKind === "selection_unavailable") {
    return { outcome: "not_consulted", reason: result.reason, engineId: null, gateRecordId: result.gateRecordId };
  }
  // Uncalibrated scores stay under review (policy: scores are scores until a calibration report says otherwise), so an approval or a
  // rejection needs a calibration for this question. Until then the check records review, and it blocks nothing.
  const outcome = result.action === "AUTO_APPROVE" ? "approved" : result.action === "REJECT" ? "rejected" : "review";
  return { outcome, reason: result.reason, engineId: result.engineId, gateRecordId: result.gateRecordId };
}
