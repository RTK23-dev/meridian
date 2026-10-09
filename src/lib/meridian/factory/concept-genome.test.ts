import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDecomposedOpportunityRating,
  buildConceptGenome,
  extractConceptGenomeFromEvidence,
  compareConceptGenomes,
  createCreativeConcept,
  formatDecomposedOpportunityReport,
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

  // Check interaction metrics are computed faithfully
  assert.equal(rating.observedBreakout.likesLift, 0.071);
  assert.equal(rating.observedBreakout.commentsLift, 0.005);

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
  assert.equal(rating.observedBreakout.uncalibratedPrior, true);
  assert.equal(rating.observedBreakout.confidence, undefined);
  assert.equal(rating.ratingStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(rating.isCalibrated, false);
});

test("Gold-Set Benchmark: Distinguishes genuine viral outliers, ordinary baseline, false positives, and missing evidence", () => {
  // Case A: Genuine viral outlier on a 20k creator (10x lift, validated angle bible genes, strong brand fit)
  const genuineOutlier = calculateDecomposedOpportunityRating({
    observed: {
      views: 200000,
      creatorMedianViews: 20000,
      likes: 18000,
      comments: 1400,
      controlSetSize: 15,
      postAgeHours: 24,
    },
    conceptGenes: ["result-first", "cinematic-cut"],
    transferContext: {
      brandFit: 0.9,
      productFit: 0.85,
      productionFeasibility: 0.9,
      isMegaCreator: false,
    },
  });

  // Case B: Ordinary baseline performance on same creator (1.0x lift)
  const ordinaryContent = calculateDecomposedOpportunityRating({
    observed: {
      views: 20000,
      creatorMedianViews: 20000,
      likes: 1200,
      comments: 90,
      controlSetSize: 15,
      postAgeHours: 24,
    },
    conceptGenes: ["result-first"],
    transferContext: {
      brandFit: 0.7,
      productFit: 0.7,
      isMegaCreator: false,
    },
  });

  // Case C: False positive: Mega celebrity with 1M absolute views, but creator median is 3M (0.33x lift) and celebrity affinity is non-transferable
  const celebrityFalsePositive = calculateDecomposedOpportunityRating({
    observed: {
      views: 1000000,
      creatorMedianViews: 3000000,
      likes: 40000,
      comments: 1200,
      controlSetSize: 20,
      postAgeHours: 24,
    },
    conceptGenes: [],
    transferContext: {
      brandFit: 0.5,
      productFit: 0.5,
      isMegaCreator: true,
    },
  });

  // Case D: Missing evidence / uncalibrated prior
  const uncalibratedPriorCase = calculateDecomposedOpportunityRating({
    conceptGenes: [],
  });

  // Assertions establishing gold-set ordering & calibration honesty:
  assert.ok(genuineOutlier.ratingOutOfTen > ordinaryContent.ratingOutOfTen);
  assert.ok(ordinaryContent.ratingOutOfTen > celebrityFalsePositive.ratingOutOfTen);
  assert.ok(genuineOutlier.ratingOutOfTen >= 7.5, "Outlier should rank high");
  assert.ok(celebrityFalsePositive.ratingOutOfTen <= 4.5, "False positive with sub-baseline views should be penalized");
  assert.equal(celebrityFalsePositive.observedBreakout.viewsLift, 0.33);

  // Calibration honesty assertions:
  assert.equal(genuineOutlier.isCalibrated, false);
  assert.equal(uncalibratedPriorCase.ratingStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(uncalibratedPriorCase.uncalibratedPrior, true);
  assert.equal(uncalibratedPriorCase.evidenceCoverage, 0); // zero free dimensions!
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

test("extractConceptGenomeFromEvidence finds matching Angle Bible cues", () => {
  const genome = extractConceptGenomeFromEvidence({
    genomeId: "extracted-01",
    transcript: "Stop doing standard curls if you want big biceps. Here is the exact negative inversion protocol.",
    ocrText: ["STOP DOING THIS"],
    onScreenActions: ["Close up finished arm result"],
  });

  assert.equal(genome.genomeId, "extracted-01");
  assert.ok(genome.angleBibleSlugs.length > 0);
  assert.ok(genome.angleBibleSlugs.includes("negative-inversion"));
});

test("compareConceptGenomes measures dimension overlap", () => {
  const genomeA = buildConceptGenome({
    genomeId: "gA",
    slugs: ["result-first", "negative-inversion"],
  });
  const genomeB = buildConceptGenome({
    genomeId: "gB",
    slugs: ["negative-inversion", "oddly-satisfying-action"],
  });

  const comparison = compareConceptGenomes(genomeA, genomeB);
  assert.equal(comparison.sharedDimensions.length, 1);
  assert.equal(comparison.sharedDimensions[0], "negative-inversion");
  assert.ok(comparison.similarity > 0 && comparison.similarity < 1);
});

test("createCreativeConcept and formatDecomposedOpportunityReport produce structured artifacts", () => {
  const genome = buildConceptGenome({
    genomeId: "g1",
    slugs: ["result-first"],
  });
  const rating = calculateDecomposedOpportunityRating({
    observed: { views: 50000, creatorMedianViews: 10000, postAgeHours: 24 },
    conceptGenes: ["result-first"],
    businessTelemetry: { roas: 2.8, conversionRate: 0.045 },
  });

  const concept = createCreativeConcept({
    conceptId: "concept-101",
    name: "Result-First Transformation",
    mechanismDescription: "Opens with final dramatic result before explaining mechanism",
    genome,
    scores: rating,
  });

  assert.equal(concept.conceptId, "concept-101");
  assert.equal(concept.scores.businessPotential.downstreamValueBand, "EXCEPTIONAL");

  const report = formatDecomposedOpportunityReport(rating);
  assert.ok(report.includes("Opportunity Score:"));
  assert.ok(report.includes("Observed Breakout Score:"));
  assert.ok(report.includes("Business Potential:"));
});
