import assert from "node:assert/strict";
import test from "node:test";
import { CreativeDecisionEngine } from "./engine.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";

const sampleBrief = {
  title: "Sleep Calm Gummies",
  hook: "Tired of waking up at 3 AM?",
  message: "Natural magnesium and L-theanine formula for deep rest.",
  cta: "Try Sleep Calm with a 30-day money-back guarantee.",
  targetDurationSeconds: 8,
};

test("CreativeDecisionEngine: image_only scope creates image deliverables and ZERO video jobs", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "manual",
    brief: sampleBrief,
  });

  assert.equal(plan.scope, "image_only");
  assert.equal(plan.deliverables.length, 3);
  assert.ok(plan.deliverables.every((d) => d.kind === "image"));
  // Zero video deliverables or jobs
  assert.equal(plan.deliverables.filter((d) => d.kind === "video").length, 0);
  assert.equal(plan.productionPlan.filter((s) => s.action === "generate_video").length, 0);
  assert.ok(plan.whyOtherFormatsRejected.video.includes("image_only"));
});

test("CreativeDecisionEngine: video_only scope creates video deliverable and ZERO image deliverables", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "video_only",
    autonomy: "semi_automatic",
    brief: sampleBrief,
  });

  assert.equal(plan.scope, "video_only");
  assert.equal(plan.deliverables.length, 1);
  assert.equal(plan.deliverables[0].kind, "video");
  assert.equal(plan.deliverables[0].provider, "google_omni");
  // Zero image deliverables or steps
  assert.equal(plan.deliverables.filter((d) => d.kind === "image").length, 0);
  assert.equal(plan.productionPlan.filter((s) => s.action === "generate_image").length, 0);
});

test("CreativeDecisionEngine: carousel_only scope creates N slide deliverables and ZERO video jobs", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "carousel_only",
    autonomy: "manual",
    brief: sampleBrief,
  });

  assert.equal(plan.scope, "carousel_only");
  assert.equal(plan.deliverables.length, 4);
  assert.ok(plan.deliverables.every((d) => d.kind === "carousel_slide"));
  // Zero video jobs
  assert.equal(plan.deliverables.filter((d) => d.kind === "video").length, 0);
  assert.equal(plan.productionPlan.filter((s) => s.action === "generate_video").length, 0);
});

test("CreativeDecisionEngine: mixed_campaign creates video, carousel slides and image variants", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "mixed_campaign",
    autonomy: "semi_automatic",
    brief: sampleBrief,
  });

  assert.equal(plan.scope, "mixed_campaign");
  const videoDelivs = plan.deliverables.filter((d) => d.kind === "video");
  const slideDelivs = plan.deliverables.filter((d) => d.kind === "carousel_slide");
  const imageDelivs = plan.deliverables.filter((d) => d.kind === "image");

  assert.equal(videoDelivs.length, 1);
  assert.equal(slideDelivs.length, 3);
  assert.equal(imageDelivs.length, 2);
  assert.equal(plan.deliverables.length, 6);
});

test("CreativeDecisionEngine: research_only creates ZERO deliverables and ZERO production steps", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "research_only",
    autonomy: "manual",
    brief: sampleBrief,
  });

  assert.equal(plan.scope, "research_only");
  assert.equal(plan.deliverables.length, 0);
  assert.equal(plan.productionPlan.length, 0);
  assert.equal(plan.estimatedCost.totalEstimatedUsd, 0);
});

test("CreativeDecisionEngine: provider selection resolves its own compatible registered model", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "video_only",
    autonomy: "manual",
    preferredVideoProvider: "hypit",
    brief: sampleBrief,
  });
  assert.equal(plan.deliverables[0]?.provider, "hypit");
  assert.equal(plan.deliverables[0]?.model, "hypit-hyperframes");
  assert.equal(plan.productionPlan[0]?.providerId, "hypit");
  assert.equal(plan.productionPlan[0]?.modelId, "hypit-hyperframes");
});

test("CreativeDecisionEngine: inadmissible JEV output blocks explicit creative scopes", () => {
  for (const status of ["abstain_malformed", "abstain_insufficient_evidence", "abstain_rejected"] as const) {
    const plan = CreativeDecisionEngine.createPlan({
      lineage: TEST_PLAN_LINEAGE,
      productionContext: TEST_PRODUCTION_CONTEXT,
      scope: "video_only",
      autonomy: "fully_automatic",
      brief: sampleBrief,
      jevJudgments: {
        status,
        decisionId: "decision-invalid",
        recommendedFormats: [{ format: "video", rationale: "untrusted partial output", priority: 1 }],
        formatSuitability: {},
        evidenceRefs: [],
        questionSetVersion: "v1",
        provider: "test",
        model: "test",
      },
    });

    assert.equal(plan.deliverables.length, 0, `${status} must not create deliverables`);
    assert.equal(plan.productionPlan.length, 0, `${status} must not create production steps`);
    assert.ok(plan.status === "abstained" || plan.status === "rejected");
  }
});

test("CreativeDecisionEngine: autonomy modes enforce approval gates", () => {
  // 1. Manual mode
  const manualPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "manual",
    brief: sampleBrief,
  });
  assert.ok(manualPlan.approvalRequirements.some((a) => a.status === "pending" && a.requiredBeforeAction === "production_execution"));

  // 2. Semi-automatic mode
  const semiPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "video_only",
    autonomy: "semi_automatic",
    brief: sampleBrief,
  });
  assert.ok(semiPlan.approvalRequirements.some((a) => a.status === "pending"));

  // 3. Fully automatic mode within spend cap
  const autoPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "fully_automatic",
    brief: sampleBrief,
    constraints: { maxSpendUsd: 5.0 },
  });
  assert.ok(autoPlan.approvalRequirements.every((a) => a.status === "auto_approved"));

  // 4. Fully automatic exceeding spend cap requires approval
  const expensiveAutoPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "mixed_campaign",
    autonomy: "fully_automatic",
    brief: sampleBrief,
    constraints: { maxSpendUsd: 0.10 }, // Cap is $0.10, mixed campaign is ~$1.45
  });
  assert.ok(expensiveAutoPlan.approvalRequirements.some((a) => a.status === "pending" && a.level === "spend_threshold"));
});
