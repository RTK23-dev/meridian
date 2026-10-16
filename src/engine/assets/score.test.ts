import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredWeights, compareScored, continuityValue, controlValue, costEfficiencyValues, latencyValues, scoreProvider } from "./score.ts";

const weights = configuredWeights();

describe("provider score with unknowns", () => {
  it("is the mean over the known dimensions, and an unknown is neither 0 nor 1", () => {
    const onlyCost = scoreProvider({ costEfficiency: 0.5 }, weights);
    assert.ok(Math.abs((onlyCost.score as number) - 0.5) < 1e-9);
    assert.deepEqual(onlyCost.known, ["costEfficiency"]);
    assert.ok(onlyCost.unknown.includes("reliability"));

    const withQuality = scoreProvider({ costEfficiency: 0.5, outputQuality: 0.9 }, weights);
    // (0.10 * 0.5 + 0.20 * 0.9) / (0.10 + 0.20) = 0.7666...
    assert.ok(Math.abs((withQuality.score as number) - 0.76667) < 0.0001);
  });

  it("is null when no dimension is known, and coverage reports how much weight is known", () => {
    const none = scoreProvider({}, weights);
    assert.equal(none.score, null);
    assert.equal(none.coverage, 0);
    const half = scoreProvider({ taskFit: 1, outputQuality: 1, control: 1, reliability: 1 }, weights);
    assert.ok(half.coverage > 0.5 && half.coverage < 1);
  });

  it("refuses values outside [0, 1] and non-finite values as unknown", () => {
    const bad = scoreProvider({ taskFit: 1.5, outputQuality: Number.NaN, control: -0.1, latency: 0.4 }, weights);
    assert.deepEqual(bad.known, ["latency"]);
    assert.ok(Math.abs((bad.score as number) - 0.4) < 1e-9);
  });
});

describe("dimension values", () => {
  it("cost efficiency is 1 minus price over the highest price, and unknown when nothing is compared", () => {
    const values = costEfficiencyValues([
      { id: "a", usd: 0.63 },
      { id: "b", usd: 0.5 },
    ]);
    assert.equal(values.get("a"), 0);
    assert.ok(Math.abs((values.get("b") as number) - (1 - 0.5 / 0.63)) < 1e-9);
    assert.equal(costEfficiencyValues([{ id: "only", usd: 0.4 }]).get("only"), null);
    assert.equal(costEfficiencyValues([{ id: "x", usd: 0.4 }, { id: "y", usd: 0.4 }]).get("x"), null);
  });

  it("latency needs two measured candidates; the fastest scores 1", () => {
    const values = latencyValues([
      { id: "fast", ms: 60_000 },
      { id: "slow", ms: 120_000 },
      { id: "new", ms: null },
    ]);
    assert.equal(values.get("fast"), 1);
    assert.equal(values.get("slow"), 0.5);
    assert.equal(values.get("new"), null);
    assert.equal(latencyValues([{ id: "only", ms: 60_000 }]).get("only"), null);
  });

  it("control is the share of steering features the adapter declares", () => {
    assert.equal(controlValue({ firstFrame: true, lastFrame: true, refsMax: 0 }), 2 / 3);
    assert.equal(controlValue({ firstFrame: false, lastFrame: false, refsMax: 0 }), 0);
    assert.equal(controlValue({ firstFrame: true, lastFrame: true, refsMax: 4 }), 1);
  });

  it("continuity is unknown without an earlier provider, 1 for the same and 0 for another", () => {
    assert.equal(continuityValue("a", null), null);
    assert.equal(continuityValue("a", "a"), 1);
    assert.equal(continuityValue("a", "b"), 0);
  });
});

describe("ranking", () => {
  it("ranks the higher score first, unknown scores last, then coverage, then route priority", () => {
    const high = { score: scoreProvider({ outputQuality: 0.9 }, weights), priority: 2 };
    const low = { score: scoreProvider({ outputQuality: 0.2 }, weights), priority: 0 };
    const unknown = { score: scoreProvider({}, weights), priority: 0 };
    const ranked = [unknown, low, high].sort(compareScored);
    assert.equal(ranked[0], high);
    assert.equal(ranked[1], low);
    assert.equal(ranked[2], unknown);

    const sameScore = { score: scoreProvider({ costEfficiency: 0.5 }, weights), priority: 1 };
    const moreKnown = { score: scoreProvider({ costEfficiency: 0.5, control: 0.5 }, weights), priority: 3 };
    assert.equal([sameScore, moreKnown].sort(compareScored)[0], moreKnown);
    const samePriority = { score: scoreProvider({ costEfficiency: 0.5 }, weights), priority: 0 };
    assert.equal([sameScore, samePriority].sort(compareScored)[0], samePriority);
  });
});
