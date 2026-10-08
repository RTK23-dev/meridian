import assert from "node:assert/strict";
import test from "node:test";
import {
  ProductionSourceLadder,
  type SourceAssetCandidate,
} from "./source-ladder.ts";

test("selectBestAvailableAsset prioritizes Rank 1 real footage over generative Rank 4", () => {
  const ugcCandidate: SourceAssetCandidate = {
    id: "ugc-1",
    rank: 1,
    sourceType: "creator_ugc_pack",
    assetUrl: "https://cdn.example.com/ugc-hook.mp4",
    durationSec: 3.0,
    tags: ["hook", "creator"],
  };

  const genCandidate: SourceAssetCandidate = {
    id: "gen-1",
    rank: 4,
    sourceType: "ai_generated_reference",
    assetUrl: "https://cdn.example.com/ai-shot.mp4",
    durationSec: 3.0,
    tags: ["hook", "ai"],
  };

  const result = ProductionSourceLadder.selectBestAvailableAsset(
    "Pattern Interrupt Hook",
    1,
    [genCandidate, ugcCandidate]
  );

  assert.equal(result.selectedRank, 1);
  assert.equal(result.selectedAsset.id, "ugc-1");
  assert.ok(result.costEstimateUsd < 0.10);
});

test("selectBestAvailableAsset falls back to Rank 5 kinetic text when no assets exist", () => {
  const result = ProductionSourceLadder.selectBestAvailableAsset(
    "Agitation Beat",
    2,
    []
  );

  assert.equal(result.selectedRank, 5);
  assert.equal(result.selectedAsset.sourceType, "motion_graphics");
  assert.ok(result.fallbackReason?.includes("fallback"));
});

test("estimateCompositionCost accurately categorizes rework vs hybrid tiers", () => {
  const reworkResolutions = [
    { beatName: "Hook", selectedAsset: {} as SourceAssetCandidate, selectedRank: 1 as const, costEstimateUsd: 0.02 },
    { beatName: "Body", selectedAsset: {} as SourceAssetCandidate, selectedRank: 1 as const, costEstimateUsd: 0.02 },
  ];
  const reworkEst = ProductionSourceLadder.estimateCompositionCost(reworkResolutions);
  assert.equal(reworkEst.productionTier, "rework");
  assert.equal(reworkEst.totalCostUsd, 0.04);

  const hybridResolutions = [
    { beatName: "Hook", selectedAsset: {} as SourceAssetCandidate, selectedRank: 1 as const, costEstimateUsd: 0.02 },
    { beatName: "Surreal Shot", selectedAsset: {} as SourceAssetCandidate, selectedRank: 4 as const, costEstimateUsd: 1.25 },
  ];
  const hybridEst = ProductionSourceLadder.estimateCompositionCost(hybridResolutions);
  assert.equal(hybridEst.productionTier, "hybrid");
  assert.equal(hybridEst.totalCostUsd, 1.27);
});
