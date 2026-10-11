import assert from "node:assert/strict";
import test from "node:test";
import { ProviderConfigResolver } from "../config/resolver.ts";
import { normalizeGoogleImageResponse } from "../providers/nano-banana.server.ts";
import {
  buildOmniTextToVideoPayload,
  buildOmniImageToVideoPayload,
  validateOmniTask,
} from "../production/providers/omni.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import { modelCapabilityRegistry } from "../production/registry.ts";
import { ProductionRouter } from "../production/router.ts";
import { ResearchPlanner } from "../discovery/planner.ts";
import { DiscoveryService } from "../discovery/service.ts";
import { SourceRegistry } from "../sources/registry.ts";
import { compressEvidenceForJev, createEvidenceBundle } from "../evidence/bundle.ts";
import type { Sql } from "../learning/store.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "./plan-lineage.ts";

test("Gate 1: Canonical Provider Config Resolver (P0.1)", () => {
  // 1. Resolves canonical key with precedence
  const resolved = ProviderConfigResolver.resolveGoogle({
    env: {
      MERIDIAN_GEMINI_API_KEY: "canonical-key-9999",
      GEMINI_API_KEY: "legacy-key-1111",
    },
  });
  assert.equal(resolved.apiKey, "canonical-key-9999");
  assert.equal(resolved.keyFingerprint, "...9999");
  assert.equal(resolved.omniModel, "gemini-omni-1.1-flash");
  assert.equal(resolved.imageModel, "gemini-nano-banana-2.1");

  // 2. Resolves legacy alias when canonical is unset
  const legacyResolved = ProviderConfigResolver.resolveGoogle({
    env: {
      GEMINI_API_KEY: "legacy-key-8888",
    },
  });
  assert.equal(legacyResolved.apiKey, "legacy-key-8888");
  assert.equal(legacyResolved.keyFingerprint, "...8888");

  // 3. Reports unconfigured when no keys present
  const unconfigured = ProviderConfigResolver.resolveGoogle({ env: {} });
  assert.equal(unconfigured.isConfigured, false);
  assert.equal(unconfigured.apiKey, undefined);
});

test("Gate 2: Google Image REST Response Normalizer (P0.2)", () => {
  const fakePng = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRsample-bytes");
  const rawRest = {
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "image",
            mime_type: "image/png",
            data: fakePng.toString("base64"),
          },
        ],
      },
    ],
  };

  const parsed = normalizeGoogleImageResponse(rawRest);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.mimeType, "image/png");
  assert.equal(parsed.dataBase64, fakePng.toString("base64"));

  // Rejects invalid payload
  const errRes = normalizeGoogleImageResponse({ steps: [] });
  assert.ok("error" in errRes);
});

test("Gate 3: Gemini Omni Request Payloads & Image-to-Video (P0.3)", () => {
  // Text-to-video payload
  const t2v = buildOmniTextToVideoPayload({
    model: "gemini-omni-1.1-flash",
    prompt: "An urban skate park at dusk",
    aspectRatio: "9:16",
    durationSeconds: 5,
  });
  assert.deepEqual(t2v.generation_config, {
    video_config: { task: "text_to_video", duration_seconds: 5 },
  });

  // Image-to-video payload
  const i2v = buildOmniImageToVideoPayload({
    model: "gemini-omni-1.1-flash",
    prompt: "Product rotates 360 degrees",
    referenceImageUri: "https://example.com/shoe.png",
    aspectRatio: "16:9",
  });
  assert.deepEqual(i2v.generation_config, {
    video_config: { task: "image_to_video" },
  });

  // Task validation
  validateOmniTask("text_to_video");
  validateOmniTask("image_to_video");
  assert.throws(() => validateOmniTask("unsupported_video_cut" as any));
});

test("Gate 4: Durable Artifact Finalizer & Storage Failure Closed Invariant (P0.4)", async () => {
  const validMp4 = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes-for-durable-storage-testing");

  // Storage failure must fail closed
  const mockFailingDrive = {
    put: async () => {
      throw new Error("Google Drive storage offline");
    },
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };

  const executedQueries: string[] = [];
  const mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    executedQueries.push(query);
    if (query.includes("select id from production_jobs")) return [{ id: values[0] }];
    return [];
  }) as unknown as Sql;

  const res = await finalizeProductionArtifact(mockSql, {
    jobId: "job-gate-4-fail",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: { bytes: new Uint8Array(validMp4), mimeType: "video/mp4" },
    options: { driveClient: mockFailingDrive as unknown as import("../storage/drive.ts").GoogleDriveClient },
  });

  assert.equal(res.success, false);
  assert.equal(res.status, "STORAGE_PERSISTENCE_FAILED");
  // Invariant: NEVER mark COMPLETED if storage failed
  assert.ok(!executedQueries.some((q) => q.includes("status = 'COMPLETED'")));
  assert.ok(executedQueries.some((q) => q.includes("status = 'STORAGE_PERSISTENCE_FAILED'")));
});

test("Gate 5: Format Selection Enforces Exact Job Types (P0.5)", () => {
  const brief = {
    title: "Cold Brew Infusion",
    hook: "Smoothest morning energy",
    message: "12-hour steeped organic arabica",
    cta: "Order your starter pack",
  };

  // 1. image_only: zero video jobs
  const imgPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "manual",
    brief,
  });
  assert.equal(imgPlan.deliverables.filter((d) => d.kind === "video").length, 0);
  assert.equal(imgPlan.productionPlan.filter((s) => s.action === "generate_video").length, 0);

  // 2. video_only: zero image deliverable jobs
  const vidPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "video_only",
    autonomy: "semi_automatic",
    brief,
  });
  assert.equal(vidPlan.deliverables.filter((d) => d.kind === "image").length, 0);
  assert.equal(vidPlan.productionPlan.filter((s) => s.action === "generate_image").length, 0);

  // 3. carousel_only: N slide deliverables, zero video jobs
  const carPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "carousel_only",
    autonomy: "manual",
    brief,
  });
  assert.equal(carPlan.deliverables.length, 4);
  assert.ok(carPlan.deliverables.every((d) => d.kind === "carousel_slide"));
  assert.equal(carPlan.productionPlan.filter((s) => s.action === "generate_video").length, 0);

  // 4. research_only: zero production jobs
  const resPlan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "research_only",
    autonomy: "manual",
    brief,
  });
  assert.equal(resPlan.deliverables.length, 0);
  assert.equal(resPlan.productionPlan.length, 0);
});

test("Gate 6: Model Capability Registry & Gemini Omni as the Google video engine (P1.6)", () => {
  // Image models registered
  const nano = modelCapabilityRegistry.getModel("gemini-nano-banana-2.1");
  assert.ok(nano);
  assert.equal(nano.availability_state, "ACTIVE");

  const flashLite = modelCapabilityRegistry.getModel("gemini-3.1-flash-lite-image");
  assert.ok(flashLite);
  assert.equal(flashLite.availability_state, "ACTIVE");

  // Veo is not registered, and the router has no Veo provider
  assert.equal(modelCapabilityRegistry.getModel("veo-3.1-generate-preview"), undefined);
  const router = new ProductionRouter({ runtime: "production" });
  assert.equal(router.get("veo"), undefined);

  // Gemini Omni leads the automatic ranking
  const ranked = router.rankProviders({} as any, "QUALITY_FIRST");
  assert.equal(ranked.some((p) => p.id === "veo"), false);
  assert.equal(ranked[0]?.id, "google_omni", "Omni is the primary Google video engine");
});

test("Gate 7: Multi-Source Discovery with Cyclone Optional (P1.3, P1.4)", async () => {
  delete process.env.CYCLONE_GATEWAY_URL;
  delete process.env.CYCLONE_DEVICE_ID;

  const registry = new SourceRegistry();
  const plan = await ResearchPlanner.planResearch(registry, {
    scope: "niche",
    seeds: ["vintage denim"],
  });

  // Website is eligible
  assert.ok(plan.executions.some((e) => e.adapterId === "website" && e.status === "eligible"));
  // Cyclone is marked not_configured without blocking plan
  const cyclone = plan.executions.find((e) => e.adapterId === "cyclone_scout");
  assert.ok(cyclone);
  assert.equal(cyclone.isOptional, true);
  assert.equal(cyclone.status, "not_configured");

  const service = new DiscoveryService(registry);
  const mockSql = (async () => []) as unknown as Sql;
  const result = await service.startDiscoveryRun({
    organizationId: "org-1",
    brandId: "brand-1",
    scope: "niche",
    seeds: ["vintage denim"],
    sql: mockSql,
  });
  // Mission completes successfully without Cyclone
  assert.equal(result.run.status, "completed");
  assert.ok(result.run.perSourceErrors["cyclone_scout"]?.includes("not connected or configured"));
});

test("Gate 8: JEV Evidence Compression Union (P1.5)", () => {
  const sampleBundle = createEvidenceBundle({
    organizationId: "org-1",
    brandId: "brand-1",
    source: { platform: "instagram", sourceAdapter: "instagram", capturedAt: new Date().toISOString() },
    content: { type: "video" },
    transcript: [{ id: "t-1", text: "Look at this transformation", startMs: 0, endMs: 2000, confidence: 0.95 }],
    scenes: [{ index: 0, startMs: 0, endMs: 2000, shotType: "close-up", facePresence: true }],
    ocr: [{ text: "50% OFF TODAY", startMs: 0, endMs: 2000, confidence: 0.99 }],
    provenance: {
      adapterId: "instagram",
      capturedAt: new Date().toISOString(),
      sourceUrl: "https://instagram.com/p/123",
    },
  });

  // When multiple questions are evaluated, the compressed state must retain the union of required evidence
  const questions = [
    { id: "organic.visual_craft.v1" } as any,
    { id: "organic.retention_architecture.v1" } as any,
  ];

  const compressed = compressEvidenceForJev(sampleBundle, questions);
  assert.ok(compressed.scenes && compressed.scenes.length > 0, "Scenes retained");
  assert.ok(compressed.ocr && compressed.ocr.length > 0, "OCR retained");
  assert.ok(compressed.transcriptSummary, "Transcript summary retained");
});

test("Gate 9: Autonomy Mode Approval Enforcement (P1.2)", () => {
  const brief = {
    title: "Hydration Electrolytes",
    hook: "No sugar, pure minerals",
    message: "Formulated for endurance",
    cta: "Shop now",
  };

  // Manual mode requires explicit human approval
  const manual = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "manual",
    brief,
  });
  assert.ok(manual.approvalRequirements.some((a) => a.status === "pending" && a.requiredBeforeAction === "production_execution"));

  // Semi-automatic pauses for user confirmation
  const semi = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "video_only",
    autonomy: "semi_automatic",
    brief,
  });
  assert.ok(semi.approvalRequirements.some((a) => a.status === "pending"));

  // Full-auto within spend cap is auto-approved
  const autoApproved = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "fully_automatic",
    brief,
    constraints: { maxSpendUsd: 10.0 },
  });
  assert.ok(autoApproved.approvalRequirements.every((a) => a.status === "auto_approved"));
});
