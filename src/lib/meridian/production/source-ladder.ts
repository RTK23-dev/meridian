/**
 * Short-Form Video Production Source Ladder
 * 
 * Prevents AI slop and runaway compute costs by prioritizing authentic sources:
 * Rank 1: Real Footage (modular creator packs, brand library, licensed UGC)
 * Rank 2: Product Photography / 3D packshots (clean product reveals)
 * Rank 3: Licensed Stock (lifestyle environments, b-roll)
 * Rank 4: AI Video with Reference Images (impossible/surreal scenes only)
 * Rank 5: Motion Graphics & Kinetic Text (data, lists, punchy explainers)
 */

export type SourceRank = 1 | 2 | 3 | 4 | 5;

export interface SourceAssetCandidate {
  id: string;
  rank: SourceRank;
  sourceType: "creator_ugc_pack" | "product_photo_3d" | "licensed_stock" | "ai_generated_reference" | "motion_graphics";
  assetUrl: string;
  durationSec: number;
  tags: string[];
  licensingId?: string;
  creatorHandle?: string;
}

export interface BeatAssetResolution {
  beatName: string;
  selectedAsset: SourceAssetCandidate;
  selectedRank: SourceRank;
  fallbackReason?: string;
  costEstimateUsd: number;
}

// Approximate compute & licensing costs per 3-second beat by source rank
export const ESTIMATED_COST_PER_BEAT_USD: Record<SourceRank, number> = {
  1: 0.02, // Amortized owned UGC footage recut
  2: 0.05, // Product 3D/photo render
  3: 0.20, // Stock asset clip
  4: 1.25, // AI video generation with 3-5 candidate runs
  5: 0.01, // Code-driven kinetic text overlay
};

export class ProductionSourceLadder {
  /**
   * Resolves the optimal available asset for a specific beat according to the quality ladder.
   * Generation is only chosen when Ranks 1-3 cannot fulfill the beat requirements.
   */
  static selectBestAvailableAsset(
    beatName: string,
    preferredRank: SourceRank,
    availableCandidates: SourceAssetCandidate[]
  ): BeatAssetResolution {
    if (availableCandidates.length === 0) {
      // Default to Rank 5 (Kinetic motion text) as guaranteed zero-cost fallback
      const fallbackAsset: SourceAssetCandidate = {
        id: `fallback-motion-${beatName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        rank: 5,
        sourceType: "motion_graphics",
        assetUrl: "asset://procedural/kinetic-text",
        durationSec: 3.0,
        tags: ["fallback", "motion_text"],
      };

      return {
        beatName,
        selectedAsset: fallbackAsset,
        selectedRank: 5,
        fallbackReason: "No assets available in library; used kinetic motion text fallback",
        costEstimateUsd: ESTIMATED_COST_PER_BEAT_USD[5],
      };
    }

    // Sort candidates by ladder rank (1 is best, 5 is fallback)
    const sorted = [...availableCandidates].sort((a, b) => a.rank - b.rank);

    // Prefer candidate matching preferredRank, or highest available rank
    const match = sorted.find((c) => c.rank <= preferredRank) ?? sorted[0];

    return {
      beatName,
      selectedAsset: match,
      selectedRank: match.rank,
      costEstimateUsd: ESTIMATED_COST_PER_BEAT_USD[match.rank],
    };
  }

  /**
   * Computes the total production cost tier for a sequence of beats.
   */
  static estimateCompositionCost(resolutions: BeatAssetResolution[]): {
    totalCostUsd: number;
    productionTier: "rework" | "hybrid" | "fully_generated";
  } {
    const totalCost = resolutions.reduce((sum, r) => sum + r.costEstimateUsd, 0);
    const hasGeneratedShots = resolutions.some((r) => r.selectedRank === 4);
    const ranks = resolutions.map((r) => r.selectedRank);
    const allGenerated = ranks.every((r) => r === 4);

    let productionTier: "rework" | "hybrid" | "fully_generated" = "rework";
    if (allGenerated) {
      productionTier = "fully_generated";
    } else if (hasGeneratedShots) {
      productionTier = "hybrid";
    }

    return {
      totalCostUsd: Number(totalCost.toFixed(2)),
      productionTier,
    };
  }
}
