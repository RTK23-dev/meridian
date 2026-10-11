import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decide } from "./engine.ts";
import {
  claimSafety,
  creativeQa,
  opportunityGate,
  visualQa,
  type ClaimSafetyInput,
  type OpportunityGateInput,
  type TextQaInput,
  type VisionQaInput,
} from "./questions.ts";

/** A calibration step that maps a score to itself. The fixture expectations were written for calibrated values. */
const CALIBRATED = { calibration: { version: "identity.fixtures.v1", apply: (score: number) => score } };

test("evals/jev fixtures match the deterministic gate", () => {
  const cases = JSON.parse(readFileSync(new URL("../../../../evals/jev/cases.json", import.meta.url), "utf8")) as {
    name: string;
    question: string;
    input: ClaimSafetyInput & TextQaInput & VisionQaInput & OpportunityGateInput;
    expect: string;
  }[];
  assert.ok(cases.length >= 6);
  const decideCase = (item: (typeof cases)[number], context?: typeof CALIBRATED) =>
    item.question === "creative_qa"
      ? decide(creativeQa, item.input, context)
      : item.question === "claim_safety"
        ? decide(claimSafety, item.input, context)
        : item.question === "opportunity_gate"
          ? decide(opportunityGate, item.input, context)
          : decide(visualQa, item.input, context);
  for (const item of cases) {
    // Calibrated, every case gives its fixture outcome, as before.
    assert.equal(decideCase(item, CALIBRATED).decision, item.expect, item.name);
    // Uncalibrated, no case approves. The cap can only remove an approval or a score rejection. It never adds a rejection,
    // so a rejection that remains is a measured violation, and it is also a rejection when calibrated.
    const uncalibrated = decideCase(item).decision;
    assert.notEqual(uncalibrated, "AUTO_APPROVE", `${item.name}: an uncalibrated value must not approve`);
    if (uncalibrated === "REJECT") assert.equal(decideCase(item, CALIBRATED).decision, "REJECT", `${item.name}: a rejection needs a violation or a calibrated score`);
  }
  const clean = cases.find((item) => item.name === "clean creative auto-approves");
  assert.ok(clean, "the clean creative fixture is present");
  assert.equal(decideCase(clean).decision, "HUMAN_REVIEW", "the clean creative waits for calibration before it can approve");
});
