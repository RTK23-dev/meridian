import assert from "node:assert/strict";
import test from "node:test";
import { CreativeDecisionEngine, type CreativeDecisionInput } from "./engine.ts";

const brief = {
  title: "Sleep Calm Gummies",
  hook: "Tired of waking up at 3 AM?",
  message: "Natural magnesium and L-theanine formula for deep rest.",
  cta: "Try Sleep Calm with a 30-day money-back guarantee.",
  targetDurationSeconds: 8,
};

const lineage = { decisionId: "jev-decision-1", evidenceRefs: ["ev-1", "ev-2"] };

test("a plan with no lineage is refused, not produced with a placeholder source id", () => {
  const input = { scope: "video_only", autonomy: "semi_automatic", brief } as unknown as CreativeDecisionInput;
  assert.throws(() => CreativeDecisionEngine.createPlan(input), /lineage/i);
});

test("a plan whose decision id is blank is refused", () => {
  assert.throws(
    () => CreativeDecisionEngine.createPlan({ scope: "video_only", autonomy: "semi_automatic", brief, lineage: { decisionId: "  ", evidenceRefs: ["ev-1"] } }),
    /decision/i,
  );
});

test("an admissible plan that chooses a format is refused when its lineage cites no evidence", () => {
  assert.throws(
    () => CreativeDecisionEngine.createPlan({
      scope: "video_only",
      autonomy: "semi_automatic",
      brief,
      lineage: { decisionId: "jev-decision-1", evidenceRefs: [] },
      jevJudgments: {
        status: "admissible",
        recommendedFormats: [{ format: "video", rationale: "Demonstration of the mechanism", priority: 1 }],
        evidenceRefs: [],
      },
    }),
    /evidence/i,
  );
});

test("an abstained plan keeps its decision lineage even when it cites no evidence", () => {
  const plan = CreativeDecisionEngine.createPlan({
    scope: "video_only",
    autonomy: "semi_automatic",
    brief,
    lineage: { decisionId: "jev-decision-1", evidenceRefs: [] },
    jevJudgments: { status: "abstain_insufficient_evidence", recommendedFormats: [], evidenceRefs: [] },
  });
  assert.deepEqual(plan.lineage, { decisionId: "jev-decision-1", evidenceRefs: [] });
});

test("a produced plan carries exactly the lineage it was given", () => {
  const plan = CreativeDecisionEngine.createPlan({ scope: "video_only", autonomy: "semi_automatic", brief, lineage });
  assert.deepEqual(plan.lineage, lineage);
});
