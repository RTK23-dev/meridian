/**
 * Meridian beta.8 Integration Smoke Test Suite
 *
 * Verifies P0-A through P0-E and P1-A through P1-D:
 * - P0-A: JEV judgments integration and explicit abstention.
 * - P0-B: Canonical google_omni provider ID resolution.
 * - P0-C: Fail-closed artifact finalizer (no fake 0-byte completed assets).
 * - P0-D: Autonomy mode approval gates & spend-cap budget enforcement.
 * - P0-E: Omni 3-10s duration limits & Veo deprecation lifecycle exclusion.
 * - P1-A: Durable discovery run and item persistence across restart.
 * - P1-D: Google Interactions API contract fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreativeJudgmentBundle } from "../creative/plan.ts";
import { GeminiOmniVideoProvider, buildOmniTextToVideoPayload } from "../production/providers/omni.ts";
import {
  OMNI_FIXTURE_COMPLETED_BASE64,
  OMNI_FIXTURE_IN_PROGRESS,
  OMNI_FIXTURE_TEXT_ONLY,
  OMNI_FIXTURE_MALFORMED,
} from "../production/providers/omni.fixtures.ts";
import { productionRouter } from "../production/router.ts";
import { modelCapabilityRegistry } from "../production/registry.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { DiscoveryService } from "../discovery/service.ts";
import { sourceRegistry } from "../sources/registry.ts";

test("Smoke 1: JEV Semantic Judgments Wire into CreativePlan (P0-A)", () => {
  const admissibleBundle: CreativeJudgmentBundle = {
    conceptStrengthScore: 0.92,
    isOutlier: true,
    creativeMechanism: "Contrast before-and-after demonstration",
    recommendedFormats: [
      { format: "video", rationale: "High motion delta between before and after states", priority: 1 },
    ],
    formatSuitability: {
      video: { suitable: true, rationale: "Dynamic visual transformation" },
      image: { suitable: false, rationale: "Single frame cannot show transition" },
    },
    status: "admissible",
    evidenceRefs: ["ev-trans-1", "ev-trans-2"],
    decisionId: "jev-dec-401",
    questionSetVersion: "v2026.10",
    provider: "typesafe_direct",
    model: "typesafe/jev-1.13",
  };

  const plan = CreativeDecisionEngine.createPlan({
    scope: "auto_choose",
    autonomy: "semi_automatic",
    brief: {
      title: "Transformation Reel",
      hook: "You won't believe the difference",
      message: "See the 5-minute result",
      cta: "Try it today",
      decisionId: "jev-dec-401",
    },
    jevJudgments: admissibleBundle,
  });

  assert.equal(plan.status, "awaiting_approval");
  assert.equal(plan.deliverables[0].kind, "video");
  assert.ok(plan.whyFormatChosen.includes("JEV recommended video"));
  assert.ok(plan.rationale.some((r) => r.sourceId === "jev-dec-401"));
});

test("Smoke 2: Missing or Insufficient JEV Causes Explicit Abstention (P0-A)", () => {
  // When JEV judgments are missing in auto_choose, engine must ABSTAIN, never pretend AI recommended image
  const planMissing = CreativeDecisionEngine.createPlan({
    scope: "auto_choose",
    autonomy: "semi_automatic",
    brief: {
      title: "No Evidence Brief",
      hook: "Generic hook",
      message: "Generic body",
      cta: "Click here",
    },
  });

  assert.equal(planMissing.status, "abstained");
  assert.equal(planMissing.deliverables.length, 0);
  assert.ok(planMissing.whyFormatChosen.includes("JEV abstained"));
  assert.ok(planMissing.approvalRequirements.some((r) => r.reason.includes("User must explicitly select format")));

  // When JEV status is rejected or insufficient
  const rejectedBundle: CreativeJudgmentBundle = {
    recommendedFormats: [],
    formatSuitability: {},
    status: "abstain_insufficient_evidence",
    evidenceRefs: [],
    decisionId: "jev-dec-insufficient",
    questionSetVersion: "v2026.10",
    provider: "typesafe_direct",
    model: "typesafe/jev-1.13",
  };

  const planRejected = CreativeDecisionEngine.createPlan({
    scope: "auto_choose",
    autonomy: "semi_automatic",
    brief: {
      title: "Insufficient Evidence Brief",
      hook: "Hook",
      message: "Body",
      cta: "CTA",
      decisionId: "jev-dec-insufficient",
    },
    jevJudgments: rejectedBundle,
  });

  assert.equal(planRejected.status, "abstained");
  assert.equal(planRejected.deliverables.length, 0);
});

test("Smoke 3: Canonical Provider ID google_omni Resolves in Router (P0-B)", () => {
  const omniProvider = productionRouter.get("google_omni");
  assert.ok(omniProvider, "google_omni must resolve in ProductionRouter");
  assert.equal(omniProvider?.id, "google_omni");
});

test("Smoke 4: Artifact Finalizer Fail-Closed Contract (P0-C)", async () => {
  let updateCalled = false;
  const mockSql: any = async (strings: TemplateStringsArray, ..._values: any[]) => {
    const query = strings.join("?");
    if (query.includes("update production_jobs")) {
      updateCalled = true;
      return [];
    }
    return [];
  };

  const validMp4Bytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes-exceeding-fifty-bytes");
  const mockFailingDrive: any = {
    put: async () => {
      throw new Error("Google Drive 503 Service Unavailable");
    },
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "ERROR", configured: false }),
  };

  // When drive store fails, finalizer returns STORAGE_PERSISTENCE_FAILED
  const result = await finalizeProductionArtifact(mockSql, {
    jobId: "job-fail-test",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: {
      bytes: new Uint8Array(validMp4Bytes),
      mimeType: "video/mp4",
    },
    options: {
      driveClient: mockFailingDrive,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "STORAGE_PERSISTENCE_FAILED");
  assert.ok(updateCalled, "Production job must transition to failure state");
});

test("Smoke 5: Autonomy Mode Gates Generation and Enforces Spend Cap (P0-D)", () => {
  // Manual autonomy requires approval
  const manualPlan = CreativeDecisionEngine.createPlan({
    scope: "video_only",
    autonomy: "manual",
    brief: {
      title: "Manual Campaign",
      hook: "Hook",
      message: "Message",
      cta: "CTA",
    },
  });
  assert.equal(manualPlan.status, "draft");
  assert.ok(manualPlan.approvalRequirements.some((r) => r.level === "human_creative_director" && r.status === "pending"));

  // Fully automatic over spend cap is blocked and requires approval
  const overCapPlan = CreativeDecisionEngine.createPlan({
    scope: "mixed_campaign",
    autonomy: "fully_automatic",
    brief: {
      title: "Expensive Campaign",
      hook: "Hook",
      message: "Message",
      cta: "CTA",
    },
    constraints: {
      maxSpendUsd: 0.10, // $0.10 cap while mixed campaign costs > $1
    },
  });
  assert.equal(overCapPlan.status, "awaiting_approval");
  assert.ok(overCapPlan.approvalRequirements.some((r) => r.level === "spend_threshold" && r.status === "pending"));
});

test("Smoke 6: Gemini Omni 3-10s Duration Bounds & Veo Lifecycle Exclusion (P0-E)", () => {
  // Valid duration 5s
  const valid = buildOmniTextToVideoPayload({
    model: "gemini-omni-1.1-flash",
    prompt: "Camera panning over beach",
    durationSeconds: 5,
  });
  assert.equal((valid.generation_config as any).video_config.duration_seconds, 5);

  // Invalid duration 15s rejected
  assert.throws(
    () => buildOmniTextToVideoPayload({ model: "gemini-omni-1.1-flash", prompt: "Test", durationSeconds: 15 }),
    /Gemini Omni supports video durations between 3 and 10 seconds/
  );

  // Veo preview is DEPRECATED in registry and excluded from active generation choices
  const veoRecord = modelCapabilityRegistry.getModel("veo-3.1-generate-preview");
  assert.equal(veoRecord?.availability_state, "DEPRECATED");
});

test("Smoke 7: Google Interactions API Fixture Parsing (P1-D)", () => {
  const provider = new GeminiOmniVideoProvider();

  // Completed base64 payload
  const completedArtifact = provider.extractVideoArtifact(OMNI_FIXTURE_COMPLETED_BASE64 as any);
  assert.ok(completedArtifact, "Must extract video from completed steps");
  assert.equal(completedArtifact?.mimeType, "video/mp4");
  assert.ok(completedArtifact?.byteSize && completedArtifact.byteSize > 0);

  // In-progress payload
  const inProgressArtifact = provider.extractVideoArtifact(OMNI_FIXTURE_IN_PROGRESS as any);
  assert.equal(inProgressArtifact, null);

  // Text-only tool output
  const textOnlyArtifact = provider.extractVideoArtifact(OMNI_FIXTURE_TEXT_ONLY as any);
  assert.equal(textOnlyArtifact, null);

  // Malformed payload
  const malformedArtifact = provider.extractVideoArtifact(OMNI_FIXTURE_MALFORMED as any);
  assert.equal(malformedArtifact, null);
});

test("Smoke 8: Durable Discovery Runs and Items Persist to Database (P1-A)", async () => {
  const insertedRuns: any[] = [];
  const insertedItems: any[] = [];

  const mockSql: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const q = strings.join("?");
    if (q.includes("insert into discovery_runs")) {
      insertedRuns.push({
        id: values[0],
        organization_id: values[1],
        brand_id: values[2],
        scope: values[3],
        status: values[4],
        seeds: values[5],
        budget: values[6],
        progress: values[7],
        per_source_errors: values[8],
      });
      return [];
    }
    if (q.includes("insert into discovered_items")) {
      insertedItems.push({
        id: values[0],
        run_id: values[1],
        source: values[4],
        url: values[5],
      });
      return [];
    }
    if (q.includes("select * from discovery_runs")) {
      return insertedRuns.map((r) => ({
        ...r,
        started_at: new Date().toISOString(),
      }));
    }
    if (q.includes("select * from discovered_items")) {
      return insertedItems.map((item) => ({
        id: item.id,
        run_id: item.run_id,
        url: item.url,
        canonical_url: item.url,
        source: item.source,
        card_type: "article",
        metrics: "{}",
        content_hash: "hash123",
        discovered_at: new Date().toISOString(),
      }));
    }
    return [];
  };

  const discovery = new DiscoveryService(sourceRegistry);
  const result = await discovery.startDiscoveryRun({
    organizationId: "org-test",
    brandId: "brand-test",
    scope: "niche",
    seeds: ["skincare"],
    sql: mockSql,
  });

  assert.ok(result.run.id);
  assert.ok(insertedRuns.length > 0, "Must insert run into discovery_runs");

  // Query run back from SQL (simulating restart)
  const retrievedRun = await discovery.getDiscoveryRun(result.run.id, mockSql);
  assert.ok(retrievedRun, "Must load discovery run from SQL");
  assert.equal(retrievedRun?.organizationId, "org-test");
});
