import assert from "node:assert/strict";
import test from "node:test";
import { ReworkEngine, type CreatorFootagePack } from "./rework-engine.ts";
import type { FormulaCard } from "../study/formula-card.ts";

test("ReworkEngine generates multiple distinct variants with safe zone captions and punch-in", () => {
  const pack: CreatorFootagePack = {
    id: "pack-101",
    creatorHandle: "fit_alex",
    niche: "Fitness",
    licensingContractId: "contract-ugc-999",
    clips: [
      { id: "c-hook-1", type: "hook_to_camera", assetUrl: "https://cdn.example.com/h1.mp4", durationSec: 3.5, tags: ["hook"] },
      { id: "c-hook-2", type: "hook_to_camera", assetUrl: "https://cdn.example.com/h2.mp4", durationSec: 3.2, tags: ["hook"] },
      { id: "c-prod-1", type: "product_handling", assetUrl: "https://cdn.example.com/p1.mp4", durationSec: 5.0, tags: ["product"] },
      { id: "c-react-1", type: "reaction_face", assetUrl: "https://cdn.example.com/r1.mp4", durationSec: 3.0, tags: ["reaction"] },
      { id: "c-broll-1", type: "lifestyle_b_roll", assetUrl: "https://cdn.example.com/b1.mp4", durationSec: 6.0, tags: ["gym"] },
    ],
  };

  const formula: FormulaCard = {
    id: "formula-fit-01",
    title: "Glute Mistakes Negative Loop",
    niche: "Fitness",
    sourceReelPermalink: "https://instagram.com/reel/123",
    hookMechanismSlug: "negative_hook",
    formatStructureSlug: "tutorial",
    emotionalDriverSlug: "relatability",
    beats: [
      { name: "Hook", startPercent: 0, endPercent: 15, purpose: "Stop scrolling", evidenceTimestampSec: 1, editDirective: "Zoom", suggestedSourceRank: 1 },
      { name: "Agitation", startPercent: 15, endPercent: 50, purpose: "Common mistake", evidenceTimestampSec: 4, editDirective: "Broll", suggestedSourceRank: 1 },
      { name: "Solution", startPercent: 50, endPercent: 85, purpose: "Product switch", evidenceTimestampSec: 10, editDirective: "Product", suggestedSourceRank: 2 },
      { name: "Payoff Loop", startPercent: 85, endPercent: 100, purpose: "Final tip", evidenceTimestampSec: 20, editDirective: "Reaction", suggestedSourceRank: 1 },
    ],
    editGrammar: {
      targetShotDurationSec: 1.5,
      cutPacingCategory: "hyper_fast",
      bRollRatioPercent: 60,
      soundDesignTriggers: ["whoosh"],
      captionStyle: "karaoke_pop",
      textSafeZonePlacement: "upper_center",
    },
    minedAudienceLexicon: { commonDesires: [], commonObjections: [], catchphrases: [] },
    productEntryPoints: [],
    transferabilityScore: 85,
    counterfactualAnalysis: "A slow greeting would have failed",
    evidenceCitations: [{ claim: "Hook works", timestampSec: 1 }],
  };

  const variants = ReworkEngine.generateVariants(pack, formula, { variantCount: 2 });
  assert.equal(variants.length, 2);

  const v1 = variants[0];
  assert.equal(v1.timelineBeats.length, 4);
  assert.equal(v1.timelineBeats[0].punchInScale, 1.15, "Opening hook beat should have punch-in scale 1.15");
  assert.equal(v1.timelineBeats[0].captionSafeZone, "upper_center");
  assert.equal(v1.audioTrack.targetLufs, -14.0);
  assert.ok(v1.estimatedComputeCostUsd < 0.20, "Rework variant cost must be under $0.20 compute");
});
