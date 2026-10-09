import assert from "node:assert/strict";
import test from "node:test";
import type { CreativePlan, CreativeDeliverable } from "../creative/plan.ts";
import { manifestFromCreativePlan } from "./creative-manifest.ts";

test("CreativePlan to Manifest Projection: preserves all semantic creative decisions without brief leakage", () => {
  // A creative plan whose decisions intentionally diverge from a hypothetical generic brief
  const deliverable: CreativeDeliverable = {
    id: "deliv-video-custom-42",
    kind: "video",
    sequenceIndex: 0,
    format: "video_ugc",
    title: "Curiosity Gap Package Opening",
    copy: "Wait, you actually won't believe what arrived in the mail today...",
    aspectRatio: "9:16",
    targetDurationSeconds: 8,
    provider: "google_omni",
    model: "gemini-omni-1.1-flash",
    hook: {
      type: "curiosity_gap",
      text: "Wait, you actually won't believe what arrived in the mail today...",
      visual: "Extreme close-up of textured matte package sealing",
    },
    concept: {
      mechanism: "unboxing_suspense_into_product_proof",
      theme: "skepticism_to_delight",
    },
    scenes: [
      {
        id: "scene-1",
        description: "Creator cuts open package with suspenseful music",
        durationSeconds: 2,
        visualInstruction: "Hand shears paper tape in smooth diagonal motion",
        scriptOrCaption: "Wait, you won't believe this...",
        onScreenText: "UNEXPECTED PACKAGE",
      },
      {
        id: "scene-2",
        description: "Reveal of metallic casing and instant spray demonstration",
        durationSeconds: 4,
        visualInstruction: "Liquid spray mist caught in high frame rate lighting",
        scriptOrCaption: "One coat seals the entire porous surface.",
        onScreenText: "INSTANT SEAL TECH",
      },
      {
        id: "scene-3",
        description: "Water poured over sealed surface with 0% penetration",
        durationSeconds: 2,
        visualInstruction: "Water bead cascades completely off untouched paper",
        scriptOrCaption: "Link below for the 4-pack starter set.",
        onScreenText: "GET YOURS TODAY",
      },
    ],
    visualDirection: "High-contrast dynamic macro lighting with shallow depth of field",
    audioDirection: "Crisp tactile foley with ASMR cutting sounds, no generic upbeat corporate music",
    onScreenText: "UNEXPECTED PACKAGE",
  };

  const plan: CreativePlan = {
    id: "plan-durable-99",
    version: "2026.10.1",
    status: "approved",
    scope: "video_only",
    autonomy: "semi_automatic",
    objective: "conversion",
    selectedConceptId: "concept-unboxing-gap-1",
    rationale: [
      {
        topic: "hook",
        claim: "Curiosity gap yields 3.2x higher 3s retention in testing",
        groundedIn: "jev_answer",
        sourceId: "jev-dec-44",
        detail: "Progressive visual reveal outperforms talking head by 42%",
      },
    ],
    deliverables: [deliverable],
    assetPlan: [
      {
        assetId: "asset-logo-svg",
        role: "logo",
        rightsConfirmed: true,
        provenance: "BRAND_OWNED",
      },
    ],
    productionPlan: [
      {
        stepId: "step-1",
        deliverableId: "deliv-video-custom-42",
        action: "generate_video",
        providerId: "google_omni",
        modelId: "gemini-omni-1.1-flash",
        estimatedCostUsd: 1.20,
      },
    ],
    estimatedCost: {
      totalEstimatedUsd: 1.20,
      perDeliverableUsd: { "deliv-video-custom-42": 1.20 },
      isHardCapped: true,
      maxSpendUsd: 5.00,
      currency: "USD",
      label: "PRE_GENERATION_ESTIMATE",
    },
    approvalRequirements: [
      {
        id: "appr-1",
        level: "human_creative_director",
        status: "approved",
        reason: "Director confirmed curiosity gap conforms to brand guidelines",
        requiredBeforeAction: "production_execution",
      },
    ],
    fallbackPlan: [
      {
        primaryProvider: "google_omni",
        fallbackProvider: "test:video",
        triggerCondition: "provider_unavailable",
        permitted: true,
      },
    ],
    constraintsApplied: [
      {
        constraintName: "maxDuration",
        constraintValue: 10,
        source: "platform_spec",
      },
    ],
    whyFormatChosen: "Video format required to convey tactile liquid barrier demonstration",
    whyOtherFormatsRejected: { image: "Cannot show fluid flow in static image" },
    createdAt: new Date().toISOString(),
  };

  // Execute projection
  const manifest = manifestFromCreativePlan(plan, deliverable, {
    organizationId: "org-test-1",
    brandId: "brand-test-1",
    productName: "ShieldSeal Spray",
    audience: "DIY Homeowners",
  });

  // 1. Invariant: Manifest hook preserves plan deliverable hook
  assert.equal(manifest.hook?.type, plan.deliverables[0].hook?.type);
  assert.equal(manifest.hook?.text, plan.deliverables[0].hook?.text);
  assert.equal(manifest.hook?.visual, plan.deliverables[0].hook?.visual);

  // 2. Invariant: Manifest concept & mechanism preserves plan deliverable
  assert.equal(manifest.concept?.mechanism, plan.deliverables[0].concept?.mechanism);
  assert.equal(manifest.concept?.theme, plan.deliverables[0].concept?.theme);

  // 3. Invariant: Scenes match exactly
  assert.equal(manifest.scenes?.length, 3);
  assert.deepEqual(manifest.scenes, plan.deliverables[0].scenes);

  // 4. Invariant: Provider and model match exactly without silent reinterpretation
  assert.equal(manifest.production?.provider, "google_omni");
  assert.equal(manifest.production?.model, "gemini-omni-1.1-flash");
  assert.equal(manifest.production?.fallbackUsed, false);

  // 5. Invariant: Duration and Aspect Ratio preserved
  assert.equal(manifest.format.aspectRatio, "9:16");
  assert.equal(manifest.format.targetDurationSeconds, 8);

  // 6. Invariant: Fallback plan is honored when provider is unavailable
  const fallbackManifest = manifestFromCreativePlan(plan, deliverable, {
    checkProviderAvailability: (prov) => prov !== "google_omni", // simulate unavailable
  });
  assert.equal(fallbackManifest.production?.provider, "test:video");
  assert.equal(fallbackManifest.production?.fallbackUsed, true);
  assert.equal(fallbackManifest.production?.fallbackReason, "provider_unavailable");

  // 7. Invariant: Unpermitted or missing fallback throws instead of silent change
  const planNoFallback: CreativePlan = {
    ...plan,
    fallbackPlan: [],
  };
  assert.throws(
    () => {
      manifestFromCreativePlan(planNoFallback, deliverable, {
        checkProviderAvailability: () => false,
      });
    },
    /is unavailable and no permitted fallback is configured/
  );
});
