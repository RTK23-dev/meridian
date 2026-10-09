import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCreationPlan,
  buildCreativeManifest,
} from "./creative-manifest.ts";

test("validateCreationPlan marks research_only as willCreateProductionJob=false", () => {
  const check = validateCreationPlan({
    mode: "research_only",
    productionStrategy: "reuse_edit_assets",
    startingMaterial: "winning_organic_reel",
  });

  assert.equal(check.valid, true);
  assert.equal(check.willCreateProductionJob, false);
  assert.ok(check.reason?.includes("Research-only"));
});

test("buildCreativeManifest builds versioned manifest with telemetry join keys and beats", () => {
  const manifest = buildCreativeManifest({
    creativeId: "cm-001",
    conceptId: "concept-hook-negative",
    mode: "video_reel_short",
    startingMaterial: "winning_organic_reel",
    productionStrategy: "automated_remote",
    brand: {
      organizationId: "org-1",
      brandId: "brand-nike",
      product: "Running Shoes",
      audience: "Marathon Runners",
      objective: "Conversion",
    },
    format: {
      channel: "instagram",
      aspectRatio: "9:16",
      targetDurationSeconds: 15,
    },
    beats: [
      {
        id: "beat-1",
        purpose: "Pattern Interrupt Hook",
        targetDurationSeconds: 2,
        visualInstruction: "Close-up worn sneaker falling on track",
        scriptOrCaption: "Stop running in worn-out foam.",
      },
      {
        id: "beat-2",
        purpose: "Product Reveal",
        targetDurationSeconds: 6,
        visualInstruction: "Dynamic 3D spin of fresh responsive sole",
        scriptOrCaption: "Switch to carbon-infused propulsion.",
      },
    ],
    costEstimateUsd: 2.25,
  });

  assert.equal(manifest.creativeId, "cm-001");
  assert.equal(manifest.mode, "video_reel_short");
  assert.equal(manifest.beats.length, 2);
  assert.equal(manifest.cost.estimateUsd, 2.25);
  assert.equal(manifest.qc.status, "PENDING");
  assert.equal(manifest.telemetryJoinKeys.utm_campaign, "brand-nike_concept-hook-negative");
  assert.equal(manifest.telemetryJoinKeys.utm_content, "cm-001");
});

test("E.5 Acceptance 3: Carousel mode validates coherent slide count >= 2", () => {
  const invalidCarousel = validateCreationPlan({
    mode: "carousel",
    productionStrategy: "automated_provider",
    startingMaterial: "brand_assets",
    slideCount: 1, // invalid: carousel requires at least 2 slides
  });
  assert.equal(invalidCarousel.valid, false);
  assert.ok(invalidCarousel.reason?.includes("at least 2 coherent slides"));

  const validCarousel = validateCreationPlan({
    mode: "carousel",
    productionStrategy: "automated_provider",
    startingMaterial: "brand_assets",
    slideCount: 4,
  });
  assert.equal(validCarousel.valid, true);
  assert.equal(validCarousel.willCreateProductionJob, true);
});

test("E.5 Acceptance 4: Video mode requires non-empty shot or beat plan", () => {
  const invalidVideo = validateCreationPlan({
    mode: "video",
    productionStrategy: "automated_provider",
    startingMaterial: "new_brief",
    beats: [], // empty beats
  });
  assert.equal(invalidVideo.valid, false);
  assert.ok(invalidVideo.reason?.includes("non-empty shot or beat plan"));

  const validVideo = validateCreationPlan({
    mode: "video",
    productionStrategy: "automated_provider",
    startingMaterial: "new_brief",
    beats: [
      { id: "b1", purpose: "hook", visualInstruction: "Dramatic stop" },
    ],
  });
  assert.equal(validVideo.valid, true);
});

