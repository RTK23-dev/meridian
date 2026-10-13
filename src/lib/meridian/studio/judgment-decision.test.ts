import assert from "node:assert/strict";
import test from "node:test";
import type { PolicyOutcome } from "../decisions/policy.ts";
import { judgmentDecisionId, type RecordedDecision } from "./judgment-decision.ts";

const OUTCOMES: PolicyOutcome[] = ["AUTO_APPROVE", "HUMAN_REVIEW", "REJECT"];

test("a judgment is recorded under the first decision whose outcome is its rollup", () => {
  const recorded: RecordedDecision[] = [
    { id: "creative-1:brand_fit", decision: "AUTO_APPROVE" },
    { id: "creative-1:claims", decision: "REJECT" },
    { id: "creative-1:visual", decision: "REJECT" },
  ];
  assert.equal(judgmentDecisionId("REJECT", recorded), "creative-1:claims");
});

test("when the gate is more severe than every local decision, the most severe local decision is named, never a gate record", () => {
  const recorded: RecordedDecision[] = [
    { id: "creative-1:brand_fit", decision: "AUTO_APPROVE" },
    { id: "creative-1:visual", decision: "HUMAN_REVIEW" },
  ];
  // The engine gate rejected, so no local decision matches the rollup. The gate's own record id is held elsewhere.
  const gateRecordId = "0f7c6a2e-gate-record";
  const decisionId = judgmentDecisionId("REJECT", recorded);
  assert.equal(decisionId, "creative-1:visual");
  assert.notEqual(decisionId, gateRecordId);
});

test("with no recorded decision there is no decision id, so nothing is written as one", () => {
  assert.equal(judgmentDecisionId("HUMAN_REVIEW", []), "");
});

test("whatever the rollup, the decision id is one of the recorded decision ids", () => {
  const recorded: RecordedDecision[] = [
    { id: "a", decision: "AUTO_APPROVE" },
    { id: "b", decision: "HUMAN_REVIEW" },
    { id: "c", decision: "AUTO_APPROVE" },
  ];
  const known = new Set(recorded.map((item) => item.id));
  for (const rollup of OUTCOMES) {
    const decisionId = judgmentDecisionId(rollup, recorded);
    assert.ok(known.has(decisionId), `rollup ${rollup} names a recorded decision`);
  }
});
