import assert from "node:assert/strict";
import test from "node:test";
import { gateText, planText, predictionStatusText, predictionText, variantHeading } from "./grades-model.ts";

test("a grade reads as the engine's answer with the engine and questions it was asked with, and a missing engine reads not graded", () => {
  const text = predictionText({
    state: "engine",
    action: "HUMAN_REVIEW",
    engineId: "jev",
    model: "fixture-engine-model",
    questionVersions: ["market.competitive_strength.v1@1.0.0"],
    reason: "Two questions are uncalibrated.",
  });
  assert.equal(text, "Engine answer: review, from jev (fixture-engine-model), asked market.competitive_strength.v1@1.0.0.");
  assert.equal(
    predictionText({ state: "observed_only", reason: "graded on observed signal only: no decision engine configured" }),
    "Not graded: graded on observed signal only: no decision engine configured",
  );
  assert.equal(predictionText({ state: "not_graded" }), "Not graded.");
  assert.ok(!/score/i.test(predictionText({ state: "not_graded" })), "a missing engine is never shown as a score");
});

test("the prediction status says whether the grade is the one the pick was made under", () => {
  assert.match(predictionStatusText("same"), /made under/);
  assert.match(predictionStatusText("regraded"), /graded again/);
  assert.match(predictionStatusText("regraded"), /kept/);
  assert.match(predictionStatusText("unrecorded"), /not known/);
});

test("a plan says whether it is stored, and why it is not", () => {
  assert.equal(planText("planned", ""), "Planned: a creative plan is stored for this pick.");
  assert.equal(planText("not_planned", "no engine decision backs this ad"), "Not planned: no engine decision backs this ad");
  assert.equal(planText("no_storyboard", "No storyboard is stored for this pick yet."), "No storyboard is stored for this pick yet.");
});

test("a variant names the attribute it tests and the value it sets, and the control names its own values", () => {
  const base = { hook: "Dry hands?", angle: "problem-solution", format: "demo", proof: "clinic", cta: "Shop now", gateResult: "review" };
  assert.equal(variantHeading({ ...base, attribute: "control" }), "Control: Dry hands? · problem-solution · demo · clinic · Shop now");
  assert.equal(variantHeading({ ...base, attribute: "hook" }), "Tests the hook: Dry hands?");
  assert.equal(variantHeading({ ...base, attribute: "cta" }), "Tests the call to action: Shop now");
  assert.equal(variantHeading({ ...base, attribute: "" }), "Attribute not recorded", "a variant from before attributes is not given one");
  assert.equal(variantHeading({ ...base, attribute: "proof", proof: "" }), "Tests the proof", "an empty value is not shown as a value");
});

test("a variant's gate result is shown as stored, and a variant the gate has not judged reads review", () => {
  assert.equal(gateText("block"), "Gate: block");
  assert.equal(gateText(""), "Gate: review");
});
