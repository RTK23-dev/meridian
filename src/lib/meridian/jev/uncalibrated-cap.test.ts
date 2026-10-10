/**
 * The uncalibrated cap in the shared decision rule (jev/engine.ts `decide`). A score that has no calibration step is a number,
 * not a calibrated risk. Without calibration it can route to review and nothing else. A measured violation is evidence, not a
 * score, so it still rejects.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decide, type DecisionQuestion } from "./engine.ts";

type Input = { score: number; violation?: boolean };

const question: DecisionQuestion<Input> = {
  id: "test.uncalibrated_cap.v1",
  version: "1.0.0",
  description: "A score question for the uncalibrated cap.",
  thresholds: { autoApprove: 0.9, humanReview: 0.6, minConfidenceForAuto: 0.7 },
  evaluate: (input) =>
    input.violation
      ? {
        probability: input.score,
        confidence: 0.9,
        reasons: ["A measured violation."],
        evidence: [{ id: "v", source: "test", summary: "violation" }],
        evidenceState: "violation",
      }
      : {
        probability: input.score,
        confidence: 0.9,
        reasons: ["Measured."],
        evidence: [{ id: "e", source: "test", summary: "present" }],
      },
};

const calibration = { version: "calibration.test.v1", apply: (score: number) => score };

test("uncalibrated: a score above the approval threshold is review, not approval", () => {
  const decision = decide(question, { score: 0.95 });
  assert.equal(decision.decision, "HUMAN_REVIEW");
  assert.equal(decision.calibrationVersion, null, "no calibration was applied");
});

test("calibrated: the same score above the approval threshold is approval", () => {
  const decision = decide(question, { score: 0.95 }, { calibration });
  assert.equal(decision.decision, "AUTO_APPROVE");
  assert.equal(decision.calibrationVersion, "calibration.test.v1");
});

test("uncalibrated: a score below the review line is review, never a rejection on its own", () => {
  const decision = decide(question, { score: 0.2 });
  assert.equal(decision.decision, "HUMAN_REVIEW");
});

test("calibrated: the same low score below the review line is a rejection", () => {
  assert.equal(decide(question, { score: 0.2 }, { calibration }).decision, "REJECT");
});

test("a measured violation rejects with or without calibration, because it is evidence and not a score", () => {
  assert.equal(decide(question, { score: 0.95, violation: true }).decision, "REJECT");
  assert.equal(decide(question, { score: 0.95, violation: true }, { calibration }).decision, "REJECT");
});
