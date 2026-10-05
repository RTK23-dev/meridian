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

test("evals/jev fixtures match the deterministic gate", () => {
  const cases = JSON.parse(readFileSync(new URL("../../../../evals/jev/cases.json", import.meta.url), "utf8")) as {
    name: string;
    question: string;
    input: ClaimSafetyInput & TextQaInput & VisionQaInput & OpportunityGateInput;
    expect: string;
  }[];
  assert.ok(cases.length >= 6);
  for (const item of cases) {
    const decision =
      item.question === "creative_qa"
        ? decide(creativeQa, item.input)
        : item.question === "claim_safety"
          ? decide(claimSafety, item.input)
          : item.question === "opportunity_gate"
            ? decide(opportunityGate, item.input)
            : decide(visualQa, item.input);
    assert.equal(decision.decision, item.expect, item.name);
  }
});
