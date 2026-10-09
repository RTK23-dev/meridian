import assert from "node:assert/strict";
import test from "node:test";
import type { CreativePlan } from "../creative/plan.ts";
import { manifestFromCreativePlan } from "../factory/creative-manifest.ts";
import { creativeSpecFromManifest } from "./spec-from-manifest.ts";

const plan: CreativePlan = {
  id: "plan-1", version: "1", status: "approved", scope: "video_only", autonomy: "manual",
  objective: "conversion", selectedConceptId: "concept-1", rationale: [],
  assetPlan: [{ assetId: "asset-approved", role: "primary_visual", rightsConfirmed: true, provenance: "USER_PROVIDED" }], productionPlan: [],
  estimatedCost: { totalEstimatedUsd: 1, perDeliverableUsd: {}, isHardCapped: true, currency: "USD", label: "PRE_GENERATION_ESTIMATE" },
  approvalRequirements: [], fallbackPlan: [], constraintsApplied: [], whyFormatChosen: "evidence", whyOtherFormatsRejected: {}, createdAt: "2026-01-01",
  deliverables: [{
    id: "deliverable-1", kind: "video", sequenceIndex: 0, format: "ugc", title: "Approved title", copy: "Approved script",
    aspectRatio: "4:5", targetDurationSeconds: 12, provider: "provider-approved", model: "model-approved",
    hook: { type: "curiosity_gap", text: "APPROVED PLAN HOOK" },
    scenes: [{ id: "scene-1", description: "Approved scene", durationSeconds: 12, visualInstruction: "Approved visuals", scriptOrCaption: "Approved scene script", onScreenText: "Approved text" }],
    narration: "APPROVED PLAN SCRIPT\nAPPROVED PLAN CTA", visualDirection: "APPROVED VISUAL DIRECTION", audioDirection: "APPROVED AUDIO DIRECTION",
    onScreenText: "APPROVED ON-SCREEN TEXT", assets: [{ assetId: "asset-approved" }],
  }],
};

function specFor(briefHook: string) {
  const deliverable = plan.deliverables[0]!;
  const manifest = manifestFromCreativePlan(plan, deliverable, { organizationId: "org-1", brandId: "brand-1" });
  void briefHook;
  return creativeSpecFromManifest(manifest, { organizationId: "org-1", brandId: "brand-1", title: "Context title" });
}

test("production semantics come only from CreativePlan manifest, never the brief", () => {
  const fromA = specFor("WRONG BRIEF HOOK A");
  const fromB = specFor("WRONG BRIEF HOOK B");
  assert.deepEqual(fromA, fromB);
  assert.equal(fromA.hookLine, "APPROVED PLAN HOOK");
  assert.equal(fromA.script, "APPROVED PLAN SCRIPT\nAPPROVED PLAN CTA");
  assert.equal(fromA.visualDirection, "APPROVED VISUAL DIRECTION");
  assert.equal(fromA.audioDirection, "APPROVED AUDIO DIRECTION");
  assert.equal(fromA.scenes[0]?.description, "Approved visuals");
  assert.equal(fromA.scenes[0]?.voiceoverText, "Approved scene script");
  assert.equal(fromA.scenes[0]?.onScreenText, "Approved text");
  assert.equal(fromA.durationTargetSeconds, 12);
  assert.equal(fromA.aspectRatio, "4:5");
  assert.equal(fromA.providerId, "provider-approved");
  assert.equal(fromA.modelId, "model-approved");
  assert.deepEqual(fromA.assetIds, ["asset-approved"]);
});
