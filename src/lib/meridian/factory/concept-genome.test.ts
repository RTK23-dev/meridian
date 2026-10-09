import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDecomposedOpportunityRating,
  buildConceptGenome,
} from "./concept-genome.ts";

test("calculateDecomposedOpportunityRating keeps business potential null when telemetry is absent", () => {
  const rating = calculateDecomposedOpportunityRating({
    observed: {
      views: 120000,
      creatorMedianViews: 20000,
      likes: 8500,
      comments: 650,
      controlSetSize: 12,
    },
    conceptGenes: ["result-first", "cinematic-cut"],
    transferContext: {
      brandFit: 0.9,
      productFit: 0.85,
    },
  });

  assert.equal(rating.businessPotential.score, null);
  assert.equal(rating.businessPotential.epistemicState, "UNKNOWN");
  assert.ok(rating.missingDimensions.includes("business_conversion_telemetry"));

  // Check observed breakout score was computed from real lift
  assert.equal(rating.observedBreakout.viewsLift, 6.0);
  assert.equal(rating.observedBreakout.epistemicState, "COMPUTED");
  assert.ok(rating.observedBreakout.score > 0.8);

  // Check rating is on 1.0 - 10.0 scale and reports coverage
  assert.ok(rating.ratingOutOfTen >= 1.0 && rating.ratingOutOfTen <= 10.0);
  assert.ok(rating.evidenceCoverage < 1.0); // because business potential is missing
});

test("calculateDecomposedOpportunityRating handles missing views and baselines without guessing", () => {
  const rating = calculateDecomposedOpportunityRating({
    conceptGenes: ["negative-inversion"],
  });

  assert.ok(rating.missingDimensions.includes("creator_baseline_median_views"));
  assert.ok(rating.missingDimensions.includes("observed_views"));
  assert.equal(rating.observedBreakout.viewsLift, undefined);
  assert.equal(rating.observedBreakout.confidence, 0.45);
});

test("buildConceptGenome maps Angle Bible dimensions with verified definitions", () => {
  const genome = buildConceptGenome({
    genomeId: "genome-test-01",
    slugs: ["result-first", "negative-inversion"],
    pacingSecondsPerShot: 1.5,
    loopBehavior: "seamless_audio_loop",
  });

  assert.equal(genome.genomeId, "genome-test-01");
  assert.equal(genome.angleBibleSlugs.length, 2);
  assert.ok(genome.dimensions["Hook Mechanism"]);
  assert.equal(genome.dimensions["Hook Mechanism"].dimensionId, 1);
  assert.ok(genome.dimensions["Hook Mechanism"].name.includes("Negative Inversion") || genome.dimensions["Hook Mechanism"].name.includes("Result First"));
  assert.equal(genome.pacingSecondsPerShot, 1.5);
  assert.equal(genome.loopBehavior, "seamless_audio_loop");
});
