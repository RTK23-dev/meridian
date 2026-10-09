/**
 * Control Sets & Outlier Detection
 *
 * Evaluates whether an organic creative is a genuine outlier relative to:
 * 1. Creator-normal baseline (the creator's own median performance)
 * 2. Category-normal baseline (niche benchmark median)
 *
 * Rules:
 * - A post is NOT an outlier just because it has high raw views if the creator is huge.
 * - Missing baselines prevent claiming verified outlier status.
 */

export type OutlierAssessment = {
  isOutlier: boolean;
  creatorMultiplier: number | null;
  categoryMultiplier: number | null;
  confidence: number;
  reason: string;
  evidenceBasis: "creator_and_category" | "creator_only" | "category_only" | "insufficient_baseline";
};

export function evaluateOrganicOutlier(input: {
  postViews: number;
  creatorMedianViews?: number | null;
  categoryMedianViews?: number | null;
  outlierThresholdMultiplier?: number;
}): OutlierAssessment {
  const threshold = input.outlierThresholdMultiplier ?? 3.0;
  const hasCreator = typeof input.creatorMedianViews === "number" && input.creatorMedianViews > 0;
  const hasCategory = typeof input.categoryMedianViews === "number" && input.categoryMedianViews > 0;

  if (!hasCreator && !hasCategory) {
    return {
      isOutlier: false,
      creatorMultiplier: null,
      categoryMultiplier: null,
      confidence: 0.1,
      reason: "No creator or category baseline available. Cannot classify as outlier.",
      evidenceBasis: "insufficient_baseline",
    };
  }

  const creatorMult = hasCreator ? input.postViews / input.creatorMedianViews! : null;
  const categoryMult = hasCategory ? input.postViews / input.categoryMedianViews! : null;

  if (hasCreator && hasCategory) {
    const isOutlier = creatorMult! >= threshold && categoryMult! >= 1.5;
    return {
      isOutlier,
      creatorMultiplier: Math.round(creatorMult! * 10) / 10,
      categoryMultiplier: Math.round(categoryMult! * 10) / 10,
      confidence: 0.88,
      reason: isOutlier
        ? `Post achieved ${creatorMult!.toFixed(1)}x creator median views and ${categoryMult!.toFixed(1)}x category benchmark.`
        : `Post views do not clear outlier thresholds (${creatorMult!.toFixed(1)}x creator, ${categoryMult!.toFixed(1)}x category).`,
      evidenceBasis: "creator_and_category",
    };
  }

  if (hasCreator) {
    const isOutlier = creatorMult! >= threshold;
    return {
      isOutlier,
      creatorMultiplier: Math.round(creatorMult! * 10) / 10,
      categoryMultiplier: null,
      confidence: 0.65,
      reason: isOutlier
        ? `Post achieved ${creatorMult!.toFixed(1)}x creator median views (category baseline missing).`
        : `Post achieved ${creatorMult!.toFixed(1)}x creator median views, below the ${threshold}x outlier threshold.`,
      evidenceBasis: "creator_only",
    };
  }

  const isOutlier = categoryMult! >= threshold;
  return {
    isOutlier,
    creatorMultiplier: null,
    categoryMultiplier: Math.round(categoryMult! * 10) / 10,
    confidence: 0.50,
    reason: isOutlier
      ? `Post achieved ${categoryMult!.toFixed(1)}x category median views (creator baseline missing).`
      : `Post achieved ${categoryMult!.toFixed(1)}x category median views, below the ${threshold}x outlier threshold.`,
    evidenceBasis: "category_only",
  };
}
