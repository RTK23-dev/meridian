import assert from "node:assert/strict";
import test from "node:test";
import { weights } from "../config/weights.ts";
import { EngineError, type VisualType } from "../contracts/index.ts";
import {
  artifactRiskOf,
  runLengthOf,
  scoreCandidate,
  styleFitOf,
  winRateOf,
  type LearnedStats,
  type ScoreContext,
} from "./score.ts";

const NO_LEARNING: LearnedStats = {};

function context(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return {
    beatRole: "hook",
    prevType: null,
    recent: [],
    remainingUsd: 4,
    styleKit: { preferredTypes: [], bannedTypes: [] },
    learned: NO_LEARNING,
    ...overrides,
  };
}

const candidate = (visualType: VisualType, extra: { proposalIndex?: number | null; totalUsd?: number } = {}) => ({
  visualType,
  proposalIndex: extra.proposalIndex ?? null,
  origin: "proposal" as const,
  totalUsd: extra.totalUsd ?? 0,
});

test("the win rate is the prior 0.5 until 30 samples, then the learned rate", () => {
  assert.equal(weights.winRateMinSamples, 30);
  assert.deepEqual(winRateOf("cinematic", undefined), { value: weights.winRatePrior.value, prior: true });
  assert.deepEqual(winRateOf("cinematic", { winRate: { cinematic: { wins: 29, samples: 29 } } }), {
    value: weights.winRatePrior.value,
    prior: true,
  });
  assert.deepEqual(winRateOf("cinematic", { winRate: { cinematic: { wins: 15, samples: 30 } } }), { value: 0.5, prior: false });
  assert.deepEqual(winRateOf("cinematic", { winRate: { cinematic: { wins: 9, samples: 30 } } }), { value: 0.3, prior: false });
});

test("a win rate with wins above its samples is refused, not used", () => {
  assert.throws(() => winRateOf("cinematic", { winRate: { cinematic: { wins: 31, samples: 30 } } }), (error: unknown) => error instanceof EngineError);
  assert.throws(() => winRateOf("cinematic", { winRate: { cinematic: { wins: -1, samples: 30 } } }), (error: unknown) => error instanceof EngineError);
});

test("the artifact risk prior comes from how the type is made, and a learned rate needs enough takes", () => {
  assert.deepEqual(artifactRiskOf("coded_graphics", undefined), { value: 0, prior: true });
  assert.deepEqual(artifactRiskOf("stock_footage", undefined), { value: 0.05, prior: true });
  assert.deepEqual(artifactRiskOf("product_hero", undefined), { value: 0.3, prior: true });
  assert.deepEqual(artifactRiskOf("product_hero", { artifactRisk: { product_hero: { failures: 5, takes: 10 } } }), {
    value: 0.3,
    prior: true,
  });
  assert.deepEqual(artifactRiskOf("product_hero", { artifactRisk: { product_hero: { failures: 3, takes: 30 } } }), {
    value: 0.1,
    prior: false,
  });
});

test("reference match: first proposal 1, second 0.6, others 0.3 (config)", () => {
  const scored = (proposalIndex: number | null) =>
    scoreCandidate(candidate("stock_footage", { proposalIndex }), context()).terms.referenceMatch;
  assert.equal(scored(0), weights.referenceMatchByOrder.first);
  assert.equal(scored(1), weights.referenceMatchByOrder.second);
  assert.equal(scored(2), weights.referenceMatchByOrder.other);
  assert.equal(scored(null), weights.referenceMatchByOrder.other);
});

test("style fit: preferred 1, banned 0 (a banned type can still be chosen only when nothing else is left), neutral otherwise", () => {
  const kit = { preferredTypes: ["ugc_presenter" as const], bannedTypes: ["cartoon_generated" as const] };
  assert.equal(styleFitOf("ugc_presenter", kit), 1);
  assert.equal(styleFitOf("cartoon_generated", kit), 0);
  assert.equal(styleFitOf("stock_footage", kit), 0.5);
});

test("repetition: the same type three shots running is penalised; two in a row is not", () => {
  assert.equal(runLengthOf("stock_footage", ["stock_footage", "ugc_presenter", "stock_footage"]), 1);
  assert.equal(runLengthOf("stock_footage", ["ugc_presenter", "stock_footage", "stock_footage"]), 2);
  const once = scoreCandidate(candidate("stock_footage"), context({ recent: ["stock_footage"] }));
  assert.equal(once.terms.repetition, 0);
  const twice = scoreCandidate(candidate("stock_footage"), context({ recent: ["stock_footage", "stock_footage"] }));
  assert.equal(twice.terms.repetition, 1, "a third shot in a row is penalised (weights.repetitionRunLength)");
});

test("continuity: the same family as the neighbour earns the bonus", () => {
  const sameFamily = scoreCandidate(candidate("react_clip"), context({ prevType: "ugc_presenter" }));
  const otherFamily = scoreCandidate(candidate("stock_footage"), context({ prevType: "ugc_presenter" }));
  assert.equal(sameFamily.terms.continuity, 1);
  assert.equal(otherFamily.terms.continuity, 0);
});

test("cost share is the candidate cost over the remaining budget, capped at 1, and zero with no budget left", () => {
  assert.equal(scoreCandidate(candidate("stock_footage", { totalUsd: 1 }), context({ remainingUsd: 4 })).terms.costShare, 0.25);
  assert.equal(scoreCandidate(candidate("stock_footage", { totalUsd: 9 }), context({ remainingUsd: 4 })).terms.costShare, 1);
  assert.equal(scoreCandidate(candidate("stock_footage", { totalUsd: 0 }), context({ remainingUsd: 0 })).terms.costShare, 0);
});

test("the score is the 7.5 formula with every weight read from config", () => {
  const v = weights.visualScore;
  const scored = scoreCandidate(
    candidate("coded_graphics", { proposalIndex: 0, totalUsd: 0 }),
    context({ beatRole: "proof", styleKit: { preferredTypes: ["coded_graphics"], bannedTypes: [] } }),
  );
  // beatFit(proof, coded_graphics) = 0.9 from the table; reference 1; style preferred 1; win prior; no cost; risk 0.
  const expected = v.beatFit.value * 0.9 + v.referenceMatch.value * 1 + v.styleFit.value * 1 + v.winRate.value * weights.winRatePrior.value;
  assert.ok(Math.abs(scored.score - expected) < 1e-12, `${scored.score} vs ${expected}`);
  assert.deepEqual(
    scored.priors,
    ["winRate", "artifactRisk"],
    "both fields are priors: nothing is learned yet, and the component prior is zero",
  );
});

test("the priors a score used are listed, so the decision can label them", () => {
  const scored = scoreCandidate(candidate("product_hero"), context());
  assert.deepEqual(scored.priors, ["winRate", "artifactRisk"]);
  const learned = scoreCandidate(
    candidate("product_hero"),
    context({ learned: { winRate: { product_hero: { wins: 30, samples: 30 } }, artifactRisk: { product_hero: { failures: 1, takes: 30 } } } }),
  );
  assert.deepEqual(learned.priors, []);
});
