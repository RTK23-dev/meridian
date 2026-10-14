import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDirectorCheck, type DirectorChoice } from "./director.ts";
import type { ShotCandidate } from "./visual.ts";

const CANDIDATE = (visualType: ShotCandidate["visualType"], generated: boolean, baseUsd: number, score: number): ShotCandidate => ({
  visualType,
  generated,
  baseUsd,
  totalUsd: generated ? baseUsd * 1.25 : baseUsd,
  score,
});

/** Two shots: a stock shot that may become product_hero (generated, 0.1), and a coded shot with no alternative. */
function choices(): DirectorChoice[] {
  return [
    {
      shotId: "shot_A",
      beatRole: "setup",
      durationMs: 2000,
      showsProduct: false,
      mustSatisfy: null,
      visualType: "stock_footage",
      generated: false,
      baseUsd: 0,
      score: 0.6,
      candidates: [CANDIDATE("stock_footage", false, 0, 0.6), CANDIDATE("product_hero", true, 0.1, 0.4)],
      prompt: "Wipe of a counter, no text in frame.",
    },
    {
      shotId: "shot_B",
      beatRole: "cta",
      durationMs: 2000,
      showsProduct: false,
      mustSatisfy: null,
      visualType: "coded_graphics",
      generated: false,
      baseUsd: 0,
      score: 0.7,
      candidates: [CANDIDATE("coded_graphics", false, 0, 0.7)],
      prompt: null,
    },
  ];
}

const APPROVE = { ok: true, swaps: [], promptEdits: [] };

describe("applyDirectorCheck (7.7)", () => {
  it("applies a swap inside the candidates that still fits the budget, and logs it", () => {
    const result = applyDirectorCheck({
      choices: choices(),
      requestBudgetUsd: 4,
      answer: { ...APPROVE, swaps: [{ shotId: "shot_A", toType: "product_hero" }] },
    });
    assert.equal(result.swapsApplied, 1);
    assert.equal(result.choices[0].visualType, "product_hero");
    assert.equal(result.choices[0].generated, true);
    const decision = result.decisions.find((item) => item.at === "shot_A");
    assert.equal(decision?.by, "director");
    assert.equal(decision?.chose, "product_hero");
  });

  it("ignores a swap outside the candidates, a swap of an unknown shot, and an unknown type name, and logs each one", () => {
    const result = applyDirectorCheck({
      choices: choices(),
      requestBudgetUsd: 4,
      answer: {
        ...APPROVE,
        swaps: [
          { shotId: "shot_B", toType: "cinematic" },
          { shotId: "shot_missing", toType: "stock_footage" },
          { shotId: "shot_A", toType: "invented_type" },
        ],
      },
    });
    assert.equal(result.swapsApplied, 0);
    assert.equal(result.swapsIgnored, 3);
    assert.deepEqual(
      result.choices.map((choice) => choice.visualType),
      ["stock_footage", "coded_graphics"],
      "no choice changed",
    );
    const reasons = result.decisions.filter((item) => item.reason.startsWith("Director swap ignored")).map((item) => item.reason);
    assert.equal(reasons.length, 3);
    assert.ok(reasons.some((reason) => /not among the shot's filtered candidates/.test(reason)));
    assert.ok(reasons.some((reason) => /not in this plan/.test(reason)));
    assert.ok(reasons.some((reason) => /not a visual type/.test(reason)));
  });

  it("ignores a swap that would take the plan over the request budget", () => {
    // The plan reserves the fixed $0.52 lines, so a budget of $0.52 leaves no room for a $0.1 product hero (0.125 with the allowance).
    const result = applyDirectorCheck({
      choices: choices(),
      requestBudgetUsd: 0.52,
      answer: { ...APPROVE, swaps: [{ shotId: "shot_A", toType: "product_hero" }] },
    });
    assert.equal(result.swapsIgnored, 1);
    assert.match(result.decisions[0].reason, /over the request budget/);
    assert.equal(result.choices[0].visualType, "stock_footage");
  });

  it("applies swaps in order, so a later swap sees the budget the earlier one left", () => {
    const tight = [
      { ...choices()[0], candidates: [CANDIDATE("stock_footage", false, 0, 0.6), CANDIDATE("product_hero", true, 0.1, 0.4)] },
      { ...choices()[0], shotId: "shot_C", candidates: [CANDIDATE("stock_footage", false, 0, 0.6), CANDIDATE("product_hero", true, 0.1, 0.4)] },
    ];
    // Fixed lines $0.52. One product hero of $0.1 reserves $0.125 (with the allowance): $0.645 in all. Two reserve $0.77.
    // A budget of $0.70 admits the first swap and refuses the second, which only then sees the budget the first left.
    const tightResult = applyDirectorCheck({
      choices: tight,
      requestBudgetUsd: 0.7,
      answer: {
        ...APPROVE,
        swaps: [
          { shotId: "shot_A", toType: "product_hero" },
          { shotId: "shot_C", toType: "product_hero" },
        ],
      },
    });
    assert.equal(tightResult.swapsApplied, 1, "the first swap fits");
    assert.equal(tightResult.swapsIgnored, 1, "the second would take the plan over $0.70");
    assert.equal(tightResult.choices[0].visualType, "product_hero");
    assert.equal(tightResult.choices[1].visualType, "stock_footage");
    const wide = applyDirectorCheck({
      choices: tight,
      requestBudgetUsd: 1,
      answer: {
        ...APPROVE,
        swaps: [
          { shotId: "shot_A", toType: "product_hero" },
          { shotId: "shot_C", toType: "product_hero" },
        ],
      },
    });
    assert.equal(wide.swapsApplied, 2);
  });

  it("applies a prompt edit only to a generated shot, and never one that asks for text", () => {
    const withGenerated = choices().map((choice) =>
      choice.shotId === "shot_A" ? { ...choice, visualType: "product_hero" as const, generated: true, baseUsd: 0.1 } : choice,
    );
    const result = applyDirectorCheck({
      choices: withGenerated,
      requestBudgetUsd: 4,
      answer: {
        ok: true,
        swaps: [],
        promptEdits: [
          { shotId: "shot_A", prompt: "Slow push-in on the counter, no text in frame." },
          { shotId: "shot_A", prompt: "A sign reading OPEN on the counter." },
          { shotId: "shot_B", prompt: "A close-up of the counter." },
        ],
      },
    });
    assert.equal(result.editsApplied, 1);
    assert.equal(result.editsIgnored, 2);
    assert.equal(result.choices[0].prompt, "Slow push-in on the counter, no text in frame.");
    assert.ok(result.decisions.some((item) => /asks for text/.test(item.reason)));
    assert.ok(result.decisions.some((item) => /not generated/.test(item.reason)));
  });

  it("records the approval as a director Decision, whichever way it went", () => {
    const yes = applyDirectorCheck({ choices: choices(), requestBudgetUsd: 4, answer: APPROVE });
    assert.equal(yes.ok, true);
    assert.equal(yes.decisions.at(-1)?.chose, "approved");
    const no = applyDirectorCheck({ choices: choices(), requestBudgetUsd: 4, answer: { ...APPROVE, ok: false } });
    assert.equal(no.ok, false);
    assert.equal(no.decisions.at(-1)?.chose, "not approved");
  });
});
