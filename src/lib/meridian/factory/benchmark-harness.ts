import { calculateDecomposedOpportunityRating, type DecomposedOpportunityRating } from "./concept-genome.ts";

export interface GoldSetItem {
  id: string;
  conceptName: string;
  creatorId: string;
  creatorTier: "small" | "medium" | "mega";
  niche: string;
  format: "video" | "carousel" | "image_ad" | "mixed";
  observed?: {
    views?: number;
    creatorMedianViews?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    postAgeHours?: number;
    controlSetSize?: number;
  };
  conceptGenes?: string[];
  transferContext?: {
    brandFit?: number;
    productFit?: number;
    productionFeasibility?: number;
    audienceRelevance?: number;
    isMegaCreator?: boolean;
    highClaimRisk?: boolean;
  };
  businessTelemetry?: {
    conversionRate?: number;
    roas?: number;
  };
  groundTruth: {
    isTrueBreakout: boolean;
    groundTruthLabel: "breakout" | "control" | "false_positive" | "declining";
    relativeLift: number;
    provenance: string;
  };
}

export interface BenchmarkEvaluationResult {
  version: string;
  sampleCount: number;
  precisionAtK: number;
  recallAtK: number;
  ndcgAtK: number;
  pairwiseOrderingAccuracy: number;
  scoreCoverage: number;
  missingDimensions: Record<string, number>;
  falsePositiveBreakdown: Record<string, number>;
  calibrationState: "uncalibrated" | "candidate_fit" | "validated";
  rankedCandidates: {
    id: string;
    conceptName: string;
    creatorTier: string;
    ratingOutOfTen: number;
    viewsLift?: number;
    isTrueBreakout: boolean;
    evidenceCoverage: number;
    missingDimensions: string[];
  }[];
}

/**
 * Standard versioned Gold Set fixtures representing diverse creators, formats, and true vs false breakouts.
 */
export const STANDARD_GOLD_SET_V1: GoldSetItem[] = [
  {
    id: "gold-small-breakout-1",
    conceptName: "Micro-hook Proof Before Mechanism",
    creatorId: "creator_small_fitness",
    creatorTier: "small",
    niche: "fitness",
    format: "video",
    observed: {
      views: 120000,
      creatorMedianViews: 12000, // 10x breakout lift!
      likes: 9600,
      comments: 720,
      controlSetSize: 15,
      postAgeHours: 48,
    },
    conceptGenes: ["result-first", "cinematic-cut"],
    groundTruth: {
      isTrueBreakout: true,
      groundTruthLabel: "breakout",
      relativeLift: 10.0,
      provenance: "observed_creator_baseline_audit",
    },
  },
  {
    id: "gold-mega-ordinary-2",
    conceptName: "Celebrity Lifestyle Vlog",
    creatorId: "creator_mega_lifestyle",
    creatorTier: "mega",
    niche: "lifestyle",
    format: "video",
    observed: {
      views: 800000,
      creatorMedianViews: 1200000, // 0.67x lift (underperforming baseline!)
      likes: 32000,
      comments: 1100,
      controlSetSize: 20,
      postAgeHours: 48,
    },
    conceptGenes: ["direct-address"],
    transferContext: {
      isMegaCreator: true,
    },
    groundTruth: {
      isTrueBreakout: false,
      groundTruthLabel: "control",
      relativeLift: 0.67,
      provenance: "celebrity_baseline_regression",
    },
  },
  {
    id: "gold-false-positive-clickbait-3",
    conceptName: "Sensational Unverified Miracle Claim",
    creatorId: "creator_skincare_anon",
    creatorTier: "medium",
    niche: "skincare",
    format: "video",
    observed: {
      views: 350000,
      creatorMedianViews: 70000, // 5x views lift initially
      likes: 8000,
      comments: 3500, // high outrage comments
      controlSetSize: 8,
      postAgeHours: 72,
    },
    conceptGenes: ["negative-inversion"],
    transferContext: {
      highClaimRisk: true, // will be penalized by claimRiskPenalty
    },
    groundTruth: {
      isTrueBreakout: false,
      groundTruthLabel: "false_positive",
      relativeLift: 5.0,
      provenance: "claims_gate_flagged_unsubstantiated",
    },
  },
  {
    id: "gold-declining-ad-4",
    conceptName: "Standard Product Carousel",
    creatorId: "brand_direct",
    creatorTier: "medium",
    niche: "apparel",
    format: "carousel",
    observed: {
      views: 15000,
      creatorMedianViews: 30000,
      likes: 300,
      controlSetSize: 10,
    },
    conceptGenes: ["feature-carousel"],
    groundTruth: {
      isTrueBreakout: false,
      groundTruthLabel: "declining",
      relativeLift: 0.5,
      provenance: "fatigued_brand_control",
    },
  },
  {
    id: "gold-high-performance-telemetry-5",
    conceptName: "Problem Agitation with Clinical Proof",
    creatorId: "creator_wellness_dr",
    creatorTier: "medium",
    niche: "wellness",
    format: "video",
    observed: {
      views: 240000,
      creatorMedianViews: 40000, // 6x lift
      likes: 18000,
      comments: 1200,
      controlSetSize: 12,
    },
    conceptGenes: ["result-first", "negative-inversion"],
    businessTelemetry: {
      roas: 3.2,
      conversionRate: 0.048,
    },
    groundTruth: {
      isTrueBreakout: true,
      groundTruthLabel: "breakout",
      relativeLift: 6.0,
      provenance: "commerce_attribution_validated",
    },
  },
];

/**
 * Calculates Discounted Cumulative Gain (DCG) at K.
 */
function dcgAtK(relevances: number[], k: number): number {
  let dcg = 0;
  const limit = Math.min(k, relevances.length);
  for (let i = 0; i < limit; i++) {
    const rel = relevances[i] ?? 0;
    dcg += rel / Math.log2(i + 2); // i=0 -> log2(2)=1
  }
  return dcg;
}

/**
 * Evaluates opportunity rankings against a versioned gold set.
 * Reports ranking metrics without falsely claiming the system is calibrated.
 */
export function evaluateOpportunityRankings(
  items: GoldSetItem[] = STANDARD_GOLD_SET_V1,
  topK = 3
): BenchmarkEvaluationResult {
  const scoredItems = items.map((item) => {
    const rating: DecomposedOpportunityRating = calculateDecomposedOpportunityRating({
      observed: item.observed,
      conceptGenes: item.conceptGenes,
      transferContext: item.transferContext,
      businessTelemetry: item.businessTelemetry,
    });
    return {
      item,
      rating,
    };
  });

  // Sort candidates by opportunity rating descending
  scoredItems.sort((a, b) => b.rating.ratingOutOfTen - a.rating.ratingOutOfTen);

  const k = Math.min(topK, scoredItems.length);
  const topSlice = scoredItems.slice(0, k);

  const trueBreakoutCountInTopK = topSlice.filter((s) => s.item.groundTruth.isTrueBreakout).length;
  const totalTrueBreakouts = scoredItems.filter((s) => s.item.groundTruth.isTrueBreakout).length;

  const precisionAtK = k > 0 ? Math.round((trueBreakoutCountInTopK / k) * 100) / 100 : 0;
  const recallAtK = totalTrueBreakouts > 0 ? Math.round((trueBreakoutCountInTopK / totalTrueBreakouts) * 100) / 100 : 0;

  // NDCG Calculation
  const actualRelevances = scoredItems.map((s) => (s.item.groundTruth.isTrueBreakout ? 1 : 0));
  const idealRelevances = [...actualRelevances].sort((a, b) => b - a);
  const actualDCG = dcgAtK(actualRelevances, k);
  const idealDCG = dcgAtK(idealRelevances, k);
  const ndcgAtK = idealDCG > 0 ? Math.round((actualDCG / idealDCG) * 100) / 100 : 0;

  // Pairwise ordering accuracy: for any pair where item A is true breakout and item B is control, does score(A) > score(B)?
  let validPairs = 0;
  let concordantPairs = 0;
  for (let i = 0; i < scoredItems.length; i++) {
    for (let j = i + 1; j < scoredItems.length; j++) {
      const a = scoredItems[i]!;
      const b = scoredItems[j]!;
      if (a.item.groundTruth.isTrueBreakout !== b.item.groundTruth.isTrueBreakout) {
        validPairs++;
        const breakout = a.item.groundTruth.isTrueBreakout ? a : b;
        const nonBreakout = a.item.groundTruth.isTrueBreakout ? b : a;
        if (breakout.rating.ratingOutOfTen > nonBreakout.rating.ratingOutOfTen) {
          concordantPairs++;
        }
      }
    }
  }
  const pairwiseOrderingAccuracy = validPairs > 0 ? Math.round((concordantPairs / validPairs) * 100) / 100 : 0;

  // Evidence coverage and missingness statistics
  let totalCoverage = 0;
  const missingDimensions: Record<string, number> = {};
  const falsePositiveBreakdown: Record<string, number> = {};

  for (const s of scoredItems) {
    totalCoverage += s.rating.evidenceCoverage;
    for (const dim of s.rating.missingDimensions) {
      missingDimensions[dim] = (missingDimensions[dim] ?? 0) + 1;
    }
    if (!s.item.groundTruth.isTrueBreakout && topSlice.some((top) => top.item.id === s.item.id)) {
      const cat = s.item.groundTruth.groundTruthLabel;
      falsePositiveBreakdown[cat] = (falsePositiveBreakdown[cat] ?? 0) + 1;
    }
  }
  const scoreCoverage = Math.round((totalCoverage / scoredItems.length) * 100) / 100;

  // Governance rule: calibrationState cannot be "validated" without >= 100 observations and high precision
  let calibrationState: "uncalibrated" | "candidate_fit" | "validated" = "uncalibrated";
  if (scoredItems.length >= 100 && precisionAtK >= 0.7) {
    calibrationState = "validated";
  } else if (scoredItems.length >= 5) {
    calibrationState = "candidate_fit";
  }

  return {
    version: "v1.0.0-goldset",
    sampleCount: scoredItems.length,
    precisionAtK,
    recallAtK,
    ndcgAtK,
    pairwiseOrderingAccuracy,
    scoreCoverage,
    missingDimensions,
    falsePositiveBreakdown,
    calibrationState,
    rankedCandidates: scoredItems.map((s) => ({
      id: s.item.id,
      conceptName: s.item.conceptName,
      creatorTier: s.item.creatorTier,
      ratingOutOfTen: s.rating.ratingOutOfTen,
      viewsLift: s.rating.observedBreakout.viewsLift,
      isTrueBreakout: s.item.groundTruth.isTrueBreakout,
      evidenceCoverage: s.rating.evidenceCoverage,
      missingDimensions: s.rating.missingDimensions,
    })),
  };
}

/**
 * Governance check for promotion to "validated" state.
 * Refuses promotion unless required sample size (minimum 100) and accuracy are proven.
 */
export function checkCalibrationGovernance(
  evaluation: BenchmarkEvaluationResult,
  eligibleObservationsCount: number
): { eligible: boolean; status: "validated" | "uncalibrated" | "candidate_fit"; reason: string } {
  const MIN_OBSERVATIONS = 100;
  if (eligibleObservationsCount < MIN_OBSERVATIONS) {
    return {
      eligible: false,
      status: "uncalibrated",
      reason: `Governance block: requires at least ${MIN_OBSERVATIONS} eligible observations for validated calibration (provided: ${eligibleObservationsCount}).`,
    };
  }

  if (evaluation.precisionAtK < 0.7) {
    return {
      eligible: false,
      status: "candidate_fit",
      reason: `Governance block: precision@K (${evaluation.precisionAtK}) is below required 0.70 threshold.`,
    };
  }

  return {
    eligible: true,
    status: "validated",
    reason: "Governance requirement satisfied: observation count >= 100 and precision@K >= 0.70 verified.",
  };
}
