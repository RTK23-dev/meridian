/**
 * Rework Mode Production Engine
 * 
 * Recombines owned or licensed modular UGC footage packs into high-performing
 * short-form Reels based on proven Formula Cards.
 * 
 * Generates 10-30 distinct high-retention reel variants from a single creator shoot
 * at a fraction of generative video cost ($0.05 - $0.50 compute).
 */

import type { FormulaCard } from "../study/formula-card.ts";
import type { SourceAssetCandidate } from "./source-ladder.ts";
import { ProductionSourceLadder } from "./source-ladder.ts";

export interface CreatorFootagePack {
  id: string;
  creatorHandle: string;
  niche: string;
  licensingContractId: string;
  clips: Array<{
    id: string;
    type: "hook_to_camera" | "product_handling" | "reaction_face" | "lifestyle_b_roll";
    assetUrl: string;
    durationSec: number;
    tags: string[];
  }>;
}

export interface ReworkReelVariant {
  variantId: string;
  formulaCardId: string;
  totalDurationSec: number;
  timelineBeats: Array<{
    beatName: string;
    clipUrl: string;
    sourceRank: number;
    startSec: number;
    durationSec: number;
    punchInScale: number; // 1.0 (standard) to 1.15 (punch-in zoom for pattern interrupts)
    captionText: string;
    captionSafeZone: "upper_center" | "center_third";
  }>;
  audioTrack: {
    voiceoverUrl?: string;
    musicBedUrl: string;
    targetLufs: number; // -14 LUFS standard for Instagram Reels mobile playback
  };
  estimatedComputeCostUsd: number;
}

export class ReworkEngine {
  /**
   * Generates multiple distinct reel variants from a modular creator footage pack and formula card.
   */
  static generateVariants(
    pack: CreatorFootagePack,
    formula: FormulaCard,
    options?: { variantCount?: number; musicBedUrl?: string }
  ): ReworkReelVariant[] {
    const count = options?.variantCount ?? 3;
    const musicUrl = options?.musicBedUrl ?? "asset://audio/music-bed-upbeat-01.mp3";
    const variants: ReworkReelVariant[] = [];

    // Filter clips by type
    const hookClips = pack.clips.filter((c) => c.type === "hook_to_camera");
    const reactionClips = pack.clips.filter((c) => c.type === "reaction_face");
    const productClips = pack.clips.filter((c) => c.type === "product_handling");
    const brollClips = pack.clips.filter((c) => c.type === "lifestyle_b_roll");

    for (let i = 0; i < count; i++) {
      const hookClip = hookClips[i % Math.max(1, hookClips.length)] ?? pack.clips[0];
      const productClip = productClips[i % Math.max(1, productClips.length)] ?? pack.clips[0];
      const brollClip = brollClips[i % Math.max(1, brollClips.length)] ?? pack.clips[0];
      const reactionClip = reactionClips[i % Math.max(1, reactionClips.length)] ?? pack.clips[0];

      let currentTimeSec = 0;
      const timelineBeats: ReworkReelVariant["timelineBeats"] = [];
      const costResolutions = [];

      for (let bIndex = 0; bIndex < formula.beats.length; bIndex++) {
        const beat = formula.beats[bIndex];
        const beatDuration = (beat.endPercent - beat.startPercent) * 0.25; // 25s total reel target

        // Select clip based on beat purpose
        let selectedClip = brollClip;
        let punchIn = 1.0;

        if (bIndex === 0) {
          selectedClip = hookClip;
          punchIn = 1.15; // Punch-in for opening hook pattern interrupt
        } else if (bIndex === formula.beats.length - 2) {
          selectedClip = productClip;
        } else if (bIndex === formula.beats.length - 1) {
          selectedClip = reactionClip;
        }

        const candidate: SourceAssetCandidate = {
          id: selectedClip.id,
          rank: 1, // UGC Raw Footage Pack
          sourceType: "creator_ugc_pack",
          assetUrl: selectedClip.assetUrl,
          durationSec: beatDuration,
          tags: selectedClip.tags,
          creatorHandle: pack.creatorHandle,
          licensingId: pack.licensingContractId,
        };

        const resolution = ProductionSourceLadder.selectBestAvailableAsset(
          beat.name,
          1,
          [candidate]
        );
        costResolutions.push(resolution);

        timelineBeats.push({
          beatName: beat.name,
          clipUrl: selectedClip.assetUrl,
          sourceRank: 1,
          startSec: Number(currentTimeSec.toFixed(2)),
          durationSec: Number(beatDuration.toFixed(2)),
          punchInScale: punchIn,
          captionText: beat.purpose,
          captionSafeZone: formula.editGrammar.textSafeZonePlacement,
        });

        currentTimeSec += beatDuration;
      }

      const { totalCostUsd } = ProductionSourceLadder.estimateCompositionCost(costResolutions);

      variants.push({
        variantId: `rework-${pack.id}-${formula.id}-v${i + 1}`,
        formulaCardId: formula.id,
        totalDurationSec: Number(currentTimeSec.toFixed(2)),
        timelineBeats,
        audioTrack: {
          musicBedUrl: musicUrl,
          targetLufs: -14.0, // Mobile short form loudness standard
        },
        estimatedComputeCostUsd: totalCostUsd,
      });
    }

    return variants;
  }
}
