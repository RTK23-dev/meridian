import assert from "node:assert/strict";
import test from "node:test";
import { enableAppAliases } from "../testing/module-aliases.ts";

// The learning readers import the server-function layer, which uses the "@/" alias.
enableAppAliases();
const { confidenceIntervalOf, learnedPatternView } = await import("./actions.ts");

test("a stored interval is returned with both bounds, and a bound of zero or below zero is a real value", () => {
  assert.deepEqual(confidenceIntervalOf({ ci_low: -0.1, ci_high: 0.4 }), { low: -0.1, high: 0.4 });
  assert.deepEqual(confidenceIntervalOf({ ci_low: 0, ci_high: 0.25 }), { low: 0, high: 0.25 });
});

test("an interval the engine did not store is null, never a zero interval", () => {
  assert.equal(confidenceIntervalOf({}), null);
  assert.equal(confidenceIntervalOf({ ci_low: null, ci_high: null }), null);
  assert.equal(confidenceIntervalOf({ ci_low: -0.2, ci_high: null }), null, "one missing bound makes the interval unknown");
  assert.equal(confidenceIntervalOf({ ci_low: null, ci_high: 0.3 }), null);
});

test("a learned pattern keeps every field it had and adds its interval", () => {
  const view = learnedPatternView({
    id: "pat-1",
    attribute: "angle",
    value: "lather-proof",
    metric: "ctr",
    lift: 0.18,
    sample_size: 4,
    baseline: 0.02,
    observed: 0.024,
    impressions: 2000,
    summary: "Lather proof beats the baseline.",
    state: "VALIDATED",
    scope: "brand",
    ci_low: 0.02,
    ci_high: 0.34,
  });
  assert.deepEqual(Object.keys(view).sort(), [
    "attribute", "baseline", "confidenceInterval", "id", "impressions", "lift", "metric", "observed", "sampleSize", "scope",
    "state", "summary", "value",
  ]);
  assert.deepEqual(view.confidenceInterval, { low: 0.02, high: 0.34 });
  assert.equal(view.sampleSize, 4);
});

test("a learned pattern with no stored interval reads its interval as null", () => {
  const view = learnedPatternView({ id: "pat-2", attribute: "hook", value: "question", lift: 0.1, sample_size: 3, state: "", scope: "" });
  assert.equal(view.confidenceInterval, null);
  assert.equal(view.state, "INFERRED", "an empty state keeps its earlier default");
  assert.equal(view.scope, "brand", "an empty scope keeps its earlier default");
});
