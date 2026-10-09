import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOpportunityRankings,
  checkCalibrationGovernance,
  STANDARD_GOLD_SET_V1,
} from "./benchmark-harness.ts";
import { calculateDecomposedOpportunityRating } from "./concept-genome.ts";

test("D.5 Acceptance 1 & 2: Missing metrics remain null/unavailable and distinct from zero", () => {
  const ratingWithZero = calculateDecomposedOpportunityRating({
    observed: {
      views: 10000,
      creatorMedianViews: 10000,
      likes: 0, // explicit zero
    },
    businessTelemetry: {
      conversionRate: 0, // explicit zero
    },
  });

  const ratingMissing = calculateDecomposedOpportunityRating({
    observed: {
      views: 10000,
      creatorMedianViews: 10000,
      // likes omitted (missing)
    },
    // businessTelemetry omitted (missing)
  });

  // Zero likes produces 0 rate
  assert.equal(ratingWithZero.observedBreakout.likesLift, 0);
  assert.equal(ratingWithZero.businessPotential.attributedConversionRate, 0);

  // Missing likes leaves likesLift undefined
  assert.equal(ratingMissing.observedBreakout.likesLift, undefined);
  assert.equal(ratingMissing.businessPotential.attributedConversionRate, null);
  assert.equal(ratingMissing.businessPotential.estimatedRoas, null);
  assert.equal(ratingMissing.businessPotential.epistemicState, "UNKNOWN");
});

test("D.5 Acceptance 3: Small creator with 10x lift outranks high-view celebrity with negative lift", () => {
  const evaluation = evaluateOpportunityRankings(STANDARD_GOLD_SET_V1, 2);

  const smallBreakout = evaluation.rankedCandidates.find((c) => c.id === "gold-small-breakout-1");
  const megaOrdinary = evaluation.rankedCandidates.find((c) => c.id === "gold-mega-ordinary-2");

  assert.ok(smallBreakout, "Small creator breakout should exist");
  assert.ok(megaOrdinary, "Mega creator ordinary post should exist");

  // Even though mega has 800k views and small has 120k views, small creator has 10x lift vs 0.67x lift
  assert.ok(smallBreakout.viewsLift! > megaOrdinary.viewsLift!);
  assert.ok(
    smallBreakout.ratingOutOfTen > megaOrdinary.ratingOutOfTen,
    `Small creator rating (${smallBreakout.ratingOutOfTen}) should outrank mega creator (${megaOrdinary.ratingOutOfTen})`
  );
});

test("D.5 Acceptance 4: Default prior is labeled seed_prior and does not claim validated confidence", () => {
  const rating = calculateDecomposedOpportunityRating({
    // No concept genes provided
  });

  assert.equal(rating.conceptStrength.methodState, "seed_prior");
  assert.equal(rating.observedBreakout.confidence, undefined); // no fabricated confidence until calibrated
  assert.equal(rating.observedBreakout.uncalibratedPrior, true);
  assert.equal(rating.ratingStatus, "INSUFFICIENT_EVIDENCE");
});

test("D.5 Acceptance 5: Missing ROAS never becomes 1.0 observed", () => {
  const ratingWithConversionOnly = calculateDecomposedOpportunityRating({
    businessTelemetry: {
      conversionRate: 0.035,
      // roas omitted
    },
  });

  assert.equal(ratingWithConversionOnly.businessPotential.attributedConversionRate, 0.035);
  assert.equal(ratingWithConversionOnly.businessPotential.estimatedRoas, null);
  assert.ok(
    ratingWithConversionOnly.missingDimensions.includes("business_roas_telemetry"),
    "missingDimensions should record missing ROAS"
  );
});

test("D.5 Acceptance 6: Low-evidence candidates cannot be promoted to validated state without >=100 observations", () => {
  const evalResult = evaluateOpportunityRankings(STANDARD_GOLD_SET_V1, 2);

  // Attempt governance check with only 5 observations
  const check = checkCalibrationGovernance(evalResult, 5);
  assert.equal(check.eligible, false);
  assert.equal(check.status, "uncalibrated");
  assert.ok(check.reason.includes("requires at least 100 eligible observations"));

  // Check with >= 100 observations
  const validCheck = checkCalibrationGovernance(evalResult, 120);
  assert.equal(validCheck.eligible, true);
  assert.equal(validCheck.status, "validated");
});

test("D.5 Acceptance 7: Rankings report dimension breakdown and score version", () => {
  const evalResult = evaluateOpportunityRankings(STANDARD_GOLD_SET_V1, 3);

  assert.equal(evalResult.version, "v1.0.0-goldset");
  assert.equal(evalResult.sampleCount, 5);
  assert.ok(evalResult.precisionAtK > 0);
  assert.ok(evalResult.ndcgAtK > 0);
  assert.ok(evalResult.pairwiseOrderingAccuracy > 0.5);
  assert.ok(Object.keys(evalResult.missingDimensions).length > 0);
});

test("D.5 Acceptance 8: Gold-set evaluation is deterministic and repeatable", () => {
  const run1 = evaluateOpportunityRankings(STANDARD_GOLD_SET_V1);
  const run2 = evaluateOpportunityRankings(STANDARD_GOLD_SET_V1);

  assert.deepEqual(run1.precisionAtK, run2.precisionAtK);
  assert.deepEqual(run1.ndcgAtK, run2.ndcgAtK);
  assert.deepEqual(run1.rankedCandidates.map((r) => r.id), run2.rankedCandidates.map((r) => r.id));
});
