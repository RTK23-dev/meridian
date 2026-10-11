import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import { createTenantFixture } from "./production-fixtures.ts";

// 1. Organic Fabric & Evidence
import { createEvidenceBundle, compressEvidenceForJev } from "../evidence/bundle.ts";
import type { EvidenceBundle } from "../evidence/types.ts";
import type { SourceReference, RawArtifact } from "../sources/types.ts";
import { buildCanonicalCreativeStructure } from "../factory/creative-dna.ts";

// 2. Production & Routing
import { ProductionRouter } from "../production/router.ts";
import { GeminiOmniVideoProvider } from "../production/providers/omni.ts";
import { HiggsfieldProvider } from "../production/providers/higgsfield.ts";
import { evaluateProductionPreflight } from "../production/preflight.ts";
import { evaluateProductionPostflight } from "../production/postflight.ts";
import { pollProductionJobs } from "../production/poller.ts";
import type { CreativeSpec } from "../production/types.ts";

// 3. Publishing & Readiness
import { assessPublishing } from "../publishing/readiness.ts";

// 4. Learning & Telemetry
import { recordTelemetry, calculateTelemetryFeaturePosteriors, type TelemetryRecordInput } from "../learning/telemetry-engine.ts";
import { upsertModelParameter } from "../learning/parameters.ts";

// 5. JEV Decision Engine
import { TypeSafeDirectJevProvider } from "../jev/router.ts";
import { fixedLookup } from "../credentials/fixtures.ts";
import type { JevQuestionSpec } from "../jev/types.ts";

test("E2E Path 1: Organic Discovery -> Evidence -> Perception -> JEV -> CreativeSpec", async () => {
  // 1. Source reference & candidate
  const sourceRef: SourceReference = {
    sourceId: "src-ig-001",
    platform: "instagram",
    externalId: "post-12345",
    canonicalUrl: "https://instagram.com/p/12345",
    sourceAdapter: "instagram_graph",
    discoveredAt: new Date().toISOString(),
    evidenceAvailability: "FULL_EVIDENCE_AVAILABLE",
  };

  const rawArtifact: RawArtifact = {
    id: "raw-art-001",
    reference: sourceRef,
    type: "video",
    mimeType: "video/mp4",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    capturedAt: new Date().toISOString(),
    evidenceAvailability: "FULL_EVIDENCE_AVAILABLE",
  };

  assert.equal(rawArtifact.evidenceAvailability, "FULL_EVIDENCE_AVAILABLE");

  // 2. Normalized EvidenceBundle with provenance
  const bundle: EvidenceBundle = createEvidenceBundle({
    organizationId: "org-test",
    brandId: "brand-test",
    source: {
      platform: "instagram",
      sourceAdapter: "instagram",
      capturedAt: new Date().toISOString(),
      externalId: sourceRef.externalId || undefined,
      canonicalUrl: sourceRef.canonicalUrl || undefined,
    },
    content: {
      title: "Top 3 Skincare Mistakes",
      caption: "POV: You've been doing your routine wrong all along.",
      type: "video",
    },
    profile: {
      followers: 120_000,
      following: 300,
      category: "beauty",
    },
    performance: {
      views: { value: 250_000, state: "OBSERVED" },
      likes: { value: 18_000, state: "OBSERVED" },
      comments: { value: 640, state: "OBSERVED" },
      shares: { value: 4_200, state: "OBSERVED" },
    },
    transcript: [
      { id: "tr-1", startMs: 0, endMs: 2500, text: "Top 3 mistakes that are ruining your skin barrier.", confidence: 0.95 },
      { id: "tr-2", startMs: 2500, endMs: 8000, text: "First, you are over-exfoliating every single night.", confidence: 0.95 },
      { id: "tr-3", startMs: 8000, endMs: 14000, text: "Second, skipping sunscreen indoors when by the window.", confidence: 0.95 },
    ],
    scenes: [
      { index: 0, startMs: 0, endMs: 2500, shotType: "close_up", facePresence: true, keyframeRef: "drive://kf0.png" },
      { index: 1, startMs: 2500, endMs: 8000, shotType: "product_macro", productPresence: true, keyframeRef: "drive://kf1.png" },
      { index: 2, startMs: 8000, endMs: 14000, shotType: "talking_head", facePresence: true, keyframeRef: "drive://kf2.png" },
    ],
    ocr: [
      { text: "1. Over-exfoliating", startMs: 2600, endMs: 7000, role: "benefit", confidence: 0.9 },
      { text: "2. Skipping SPF", startMs: 8200, endMs: 13000, role: "benefit", confidence: 0.9 },
    ],
    comments: [
      { id: "c-1", text: "I did mistake 1 for years and ruined my face!", intentCategory: "praise" },
    ],
    comparisonContext: {
      outlierRatio: 3.4,
      categoryMedianViews: 75_000,
    },
    provenance: {
      adapterId: "instagram_official_graph",
      capturedAt: new Date().toISOString(),
      sourceUrl: sourceRef.canonicalUrl || "",
    },
  });

  // 3. Question-aware compression
  const visualQuestion: JevQuestionSpec = {
    id: "organic.visual_craft",
    version: "1.0",
    type: "noul",
    instructions: "Evaluate visual craft and camera framing",
    criteria: { true: "cinematic craft", false: "low craft" },
    evidenceRequirements: ["scene_frames", "ocr"],
  };
  const visualCompressed = compressEvidenceForJev(bundle, visualQuestion);
  assert.ok(visualCompressed.scenes && visualCompressed.scenes.length > 0);
  assert.ok(visualCompressed.ocr && visualCompressed.ocr.length > 0);
  assert.equal(visualCompressed.comments, undefined); // Unrelated evidence omitted

  // 4. Canonical CreativeStructure classification
  const structure = buildCanonicalCreativeStructure({
    scenes: bundle.scenes!.map((s) => ({
      index: s.index,
      startMs: s.startMs,
      endMs: s.endMs,
      shotType: { value: s.shotType || "medium", confidence: 0.9, source: { kind: "frame" } },
      presenter: { value: "creator", confidence: 0.9, source: { kind: "frame" } },
      productOnScreen: { value: !!s.productPresence, confidence: 0.9, source: { kind: "frame" } },
      setting: { value: "bathroom", confidence: 0.8, source: { kind: "frame" } },
      motion: { value: "steady", confidence: 0.8, source: { kind: "frame" } },
      overlay: { value: "text", confidence: 0.8, source: { kind: "frame" } },
    })),
    segments: bundle.transcript!.map((t) => ({ text: t.text, startMs: t.startMs, endMs: t.endMs })),
    onScreenText: bundle.ocr!.map((o) => ({ text: o.text, startMs: o.startMs, role: o.role || "bullet", confidence: 0.9 })),
    durationMs: 14000,
    cutsPerSecond: 3 / 14,
    transcript: bundle.transcript!.map((t) => t.text).join(" "),
  });

  assert.equal(structure.kind, "listicle");
  assert.equal(structure.state, "INFERRED");
  assert.equal(structure.methodId, "creative_structure_classifier.v1");
  assert.equal(structure.heuristicScore, 0.8);
  assert.equal(structure.confidence, undefined); // No fake calibrated confidence

  // 5. JEV Decision Execution with mock transport
  const fakeJevFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.state);
    assert.ok(body.questions);
    return new Response(
      JSON.stringify({
        answers: {
          "organic.visual_craft": {
            type: "noul",
            noul: 0.84,
          },
        },
      }),
      { status: 200 },
    );
  };

  const jevClient = new TypeSafeDirectJevProvider({
    lookup: fixedLookup("test-key-mock"),
    fetchImpl: fakeJevFetch,
  });

  const jevResponse = await jevClient.decide({
    organizationId: "org-test",
    brandId: "brand-test",
    state: visualCompressed,
    questions: {
      "organic.visual_craft": visualQuestion,
    },
  });

  const jevAns = jevResponse.answers["organic.visual_craft"];
  assert.equal(jevAns.status, "answered");
  assert.equal(jevAns.type, "noul");
  assert.equal(jevAns.probability, 0.84);
  assert.equal(jevAns.confidence, undefined); // Native noul has NO fabricated confidence
  assert.equal(jevAns.answer, jevAns.probability, "a noul's answer is its probability");

  // 6. Synthesize final CreativeSpec
  const creativeSpec: CreativeSpec = {
    id: "spec-e2e-1",
    organizationId: "org-test",
    brandId: "brand-test",
    title: "Barrier Restore - 3 Mistakes Angle",
    modality: "video", format: "listicle",
    aspectRatio: "9:16",
    durationTargetSeconds: 8,
    hookLine: "Top 3 mistakes ruining your skin barrier.",
    script: "Top 3 mistakes ruining your skin barrier. Stop over-exfoliating and protect your moisture with our Barrier Cream.",
    scenes: [
      { index: 0, description: "Holding up cream", durationSeconds: 2, onScreenText: "3 Skin Mistakes" },
      { index: 1, description: "Applying texture", durationSeconds: 4, onScreenText: "Barrier Restore" },
      { index: 2, description: "Call to action", durationSeconds: 2, onScreenText: "Shop Today" },
    ],
  };

  assert.equal(creativeSpec.durationTargetSeconds, 8);
});

test("E2E Path 2: CreativeSpec -> ProductionRouter -> Gemini Omni/Higgsfield/Hypit -> Postflight QC", async () => {
  const spec: CreativeSpec = {
    id: "spec-prod-1",
    organizationId: "org-test",
    brandId: "brand-test",
    title: "Hydration Drop",
    modality: "video", format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 8,
    hookLine: "Watch my skin drink this up.",
    script: "Watch my skin drink this up. 100% pure hyaluronic moisture in 3 drops.",
    scenes: [
      { index: 0, description: "Dropper closeup", durationSeconds: 4 },
      { index: 1, description: "Dewy finish", durationSeconds: 4 },
    ],
  };

  // Preflight
  const preflight = evaluateProductionPreflight(spec);
  assert.equal(preflight.passed, true);
  assert.equal(preflight.decision, "PROCEED");

  // ProductionRouter in production runtime: cannot resolve test:video
  const prodRouter = new ProductionRouter({ runtime: "production" });
  assert.equal(prodRouter.get("test:video"), undefined);
  assert.throws(() => prodRouter.register({ id: "test:video" } as any), /Cannot register test provider/);

  // Gemini Omni capability validation: rejects a duration outside its 3 to 10 second range
  const invalidDurationSpec = { ...spec, durationTargetSeconds: 15 };
  const fakeOmniFetch: typeof fetch = async () => new Response("{}", { status: 200 });
  const omniProvider = new GeminiOmniVideoProvider({ fetchImpl: fakeOmniFetch, lookup: fixedLookup("mock-gemini-key") });

  const invalidOmniJob = await omniProvider.submitJob(invalidDurationSpec);
  assert.equal(invalidOmniJob.status, "FAILED");
  assert.ok(invalidOmniJob.error?.includes("between 3 and 10 seconds"));

  // A valid duration is submitted to the Interactions endpoint, and the poll reads the video step's URI
  const validOmniFetch: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1beta/interactions") && init?.method === "POST") {
      return new Response(JSON.stringify({ interaction_id: "interactions/omni-op-12345", status: "in_progress", steps: [] }), { status: 200 });
    }
    if (String(url).includes("interactions/omni-op-12345")) {
      return new Response(
        JSON.stringify({
          id: "interactions/omni-op-12345",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: "https://storage.googleapis.com/omni-sample.mp4" }] }],
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const validOmniProvider = new GeminiOmniVideoProvider({ fetchImpl: validOmniFetch, lookup: fixedLookup("mock-gemini-key") });
  const submittedOmni = await validOmniProvider.submitJob(spec);
  assert.equal(submittedOmni.status, "RUNNING");
  assert.equal(submittedOmni.providerJobId, "interactions/omni-op-12345");

  const polledOmni = await validOmniProvider.checkJobStatus(submittedOmni.jobId, {
    organizationId: spec.organizationId,
    interactionId: submittedOmni.providerJobId,
  });
  assert.equal(polledOmni.status, "COMPLETED");
  assert.equal(polledOmni.outputArtifactId, "https://storage.googleapis.com/omni-sample.mp4");

  // Higgsfield contract test with exact model endpoint, request_id, status_url, and cancel_url. Its key comes from the
  // workspace lookup for this test, not from the environment.
  process.env.HIGGSFIELD_MODEL = "dop-v1";

  const fakeHfFetch: typeof fetch = async (url, init) => {
    if ((String(url).includes("/requests") || String(url).includes("/higgsfield/")) && init?.method === "POST") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.["Authorization"], "Key mock-hf-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.camera_motion, "pan_zoom_auto");
      return new Response(
        JSON.stringify({
          request_id: "hf-req-999",
          status: "queued",
          status_url: "https://api.higgsfield.ai/v1/requests/hf-req-999/status",
          cancel_url: "https://api.higgsfield.ai/v1/requests/hf-req-999/cancel",
        }),
        { status: 200 },
      );
    }
    if (String(url) === "https://api.higgsfield.ai/v1/requests/hf-req-999/status") {
      return new Response(
        JSON.stringify({
          status: "completed",
          video: { url: "https://cdn.higgsfield.ai/output-999.mp4" },
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const hfProvider = new HiggsfieldProvider({ fetchImpl: fakeHfFetch, lookup: fixedLookup("mock-hf-key") });
  const hfJob = await hfProvider.submitJob(spec);
  assert.equal(hfJob.status, "QUEUED");
  assert.equal(hfJob.requestId, "hf-req-999");
  assert.equal(hfJob.statusUrl, "https://api.higgsfield.ai/v1/requests/hf-req-999/status");
  assert.equal(hfJob.cancelUrl, "https://api.higgsfield.ai/v1/requests/hf-req-999/cancel");

  const polledHf = await hfProvider.checkJobStatus(hfJob.jobId, hfJob.metadata);
  assert.equal(polledHf.status, "RENDERED");
  assert.equal(polledHf.outputArtifactId, "https://cdn.higgsfield.ai/output-999.mp4");

  // Postflight QC on generated artifact
  const dummyVideoBytes = new Uint8Array(1024 * 100); // 100 KB video bytes
  // Valid MP4 container signature at offset 4..7 ("ftyp")
  dummyVideoBytes[4] = 0x66; // f
  dummyVideoBytes[5] = 0x74; // t
  dummyVideoBytes[6] = 0x79; // y
  dummyVideoBytes[7] = 0x70; // p

  const postflight = evaluateProductionPostflight({
    job: polledHf,
    videoBytes: dummyVideoBytes,
  });
  assert.equal(postflight.passed, true);
  assert.equal(postflight.decision, "APPROVE_FOR_DISTRIBUTION");
});

test("E2E Path 3: Publishing Channel Readiness -> Account Gate -> Execution", async () => {
  // Test publisher: human review only, never marks as live network ready
  const testPublisherAssess = assessPublishing({
    accounts: [],
    provider: "test:publisher",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 500_000,
    destinationUrl: "https://brand.com/product",
  });
  assert.equal(testPublisherAssess.state, "HUMAN_REVIEW");

  // Disconnected / missing account
  const unconnectedAssess = assessPublishing({
    accounts: [],
    provider: "meta",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 500_000,
    destinationUrl: "https://brand.com/product",
  });
  assert.equal(unconnectedAssess.state, "EXTERNAL_CONNECTION_REQUIRED");

  // Defective artifact (0 bytes) rejected
  const emptyArtifactAssess = assessPublishing({
    accounts: [
      {
        provider: "meta",
        status: "CONNECTED",
        accountId: "act_12345",
        permissions: ["ads_management"],
        pageId: "page_999",
        destinationUrl: "https://brand.com",
      },
    ],
    provider: "meta",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 0,
    destinationUrl: "https://brand.com",
  });
  assert.equal(emptyArtifactAssess.state, "NOT_READY");
  assert.ok(emptyArtifactAssess.summary.includes("no stored media bytes"));

  // Connected & valid artifact approved
  const readyAssess = assessPublishing({
    accounts: [
      {
        provider: "meta",
        status: "CONNECTED",
        accountId: "act_12345",
        permissions: ["ads_management"],
        pageId: "page_999",
        destinationUrl: "https://brand.com",
      },
    ],
    provider: "meta",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 1_200_000,
    destinationUrl: "https://brand.com/product",
  });
  assert.equal(readyAssess.state, "READY");
});

test("E2E Path 4: Telemetry Ingestion -> Null Handling -> Bayesian Posteriors -> Model Parameters", async () => {
  const fakeDb: any[] = [];
  const fakeSql: any = async (_strings: any, ...values: any[]) => {
    fakeDb.push(values);
    return [];
  };

  // 1. Ingest telemetry record with missing shares and conversions
  const telemetryInput: TelemetryRecordInput = {
    organizationId: "org-test",
    brandId: "brand-test",
    platform: "instagram",
    hookType: "pov",
    angle: "skincare_barrier",
    views: 10_000,
    reach: 8_500,
    hookRetention3s: 0.65,
    shares: undefined, // Missing metric
    conversions: undefined, // Missing metric
  };

  const record = await recordTelemetry(fakeSql, telemetryInput);
  assert.equal(record.views, 10_000);
  assert.equal(record.shares, null); // Strictly NULL, never coerced to 0!
  assert.equal(record.conversions, null); // Strictly NULL, never coerced to 0!

  // 2. Synthetic telemetry rejected from production learning
  const syntheticInput: TelemetryRecordInput = {
    organizationId: "org-test",
    brandId: "brand-test",
    platform: "instagram",
    views: 5_000,
    metadata: { synthetic: true },
  };
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_SYNTHETIC_TELEMETRY;

  await assert.rejects(
    () => recordTelemetry(fakeSql, syntheticInput),
    /Synthetic or simulated telemetry cannot be ingested into production learning/,
  );
  process.env.NODE_ENV = origEnv;

  // 3. Bayesian feature posteriors
  const featurePosteriors = calculateTelemetryFeaturePosteriors([record], "hookType");
  assert.equal(featurePosteriors.length, 1);
  assert.equal(featurePosteriors[0].featureValue, "pov");
  assert.ok(featurePosteriors[0].posterior.mean > 0);

  // 4. Model parameter lifecycle
  const fakeParamSql: any = async () => [
    {
      id: "param-1",
      organization_id: "org-test",
      brand_id: "brand-test",
      population: "global",
      parameter_name: "hook_pov_retention",
      version: "v1",
      state: "seed_prior",
      prior_value: 0.45,
      posterior_value: null,
      sample_size: 0,
      calibration_metrics: {},
      provenance_filter: "real_only",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const seedParam = await upsertModelParameter(fakeParamSql, {
    organizationId: "org-test",
    brandId: "brand-test",
    parameterName: "hook_pov_retention",
    priorValue: 0.45,
    state: "seed_prior",
    sampleSize: 0,
  });
  assert.equal(seedParam.state, "seed_prior");

  // Cannot validate parameter without >= 100 samples and empirical calibration score
  await assert.rejects(
    () =>
      upsertModelParameter(fakeParamSql, {
        organizationId: "org-test",
        brandId: "brand-test",
        parameterName: "hook_pov_retention",
        state: "validated",
        sampleSize: 10,
      }),
    /Cannot validate parameter without at least 100 observations/,
  );
});

test("E2E Path 5: Durable Production Jobs Poller Worker Loop", async () => {
  const sql = await getSql();
  // A real tenant with an approved brief and an executing plan; the job row is what the executor leaves in flight.
  const tenant = await createTenantFixture(sql, "poller-e2e", 50, "test:video", "test-video-model");
  const runId = `run-poller-${randomUUID()}`;
  const jobId = `prod_job_${randomUUID()}`;
  const spec: CreativeSpec = {
    id: "spec-durable",
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    title: "Durable Spec",
    modality: "video", format: "ai_video",
    aspectRatio: "9:16",
    durationTargetSeconds: 8,
    hookLine: "Durable Hook",
    script: "Durable Script",
    scenes: [],
  };

  const testProvider: any = {
    id: "test:video",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      timelineEditing: false,
      voiceoverGeneration: false,
      zeroSpend: false,
      averageLatencySeconds: 10,
      costPerSecondEstimateUsd: 0.01,
    },
    health: async () => ({ id: "test:video", state: "HEALTHY", capabilities: [], detail: "mock", checkedAt: new Date().toISOString() }),
    submitJob: async () => {
      throw new Error("fixture: the poller never submits");
    },
    checkJobStatus: async (id: string) => ({
      jobId: id,
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      creativeSpec: spec,
      providerId: "test:video",
      status: "RENDERED",
      outputArtifactId: "https://mock.storage/video.mp4",
      costEstimateUsd: 0.08,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  };
  const testRouter = new ProductionRouter({ runtime: "testing", providers: [testProvider] });

  await sql`
    insert into production_jobs (
      id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, status, cost_mode,
      estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id
    ) values (
      ${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'test:video', 'req_777', 'req_777',
      'https://api.test/jobs/req_777/status', 'RUNNING', 'BALANCED', 0,
      ${JSON.stringify({
        creativeSpec: spec,
        runId,
        briefId: tenant.briefId,
        planDeliverableId: "deliverable-poller",
        manifest: { brand: { product: "Mesh sponge" }, hook: { type: "problem", text: "Durable Hook" }, concept: { mechanism: "demo" } },
      })},
      now(), now(), now(), ${tenant.plan.id}
    )
  `;

  // Valid MP4 video bytes with an ftyp box.
  const validMp4 = new Uint8Array(2048);
  validMp4[4] = 0x66;
  validMp4[5] = 0x74;
  validMp4[6] = 0x79;
  validMp4[7] = 0x70;
  const fakeFetch: typeof fetch = async (url) => {
    if (String(url).includes("video.mp4")) {
      return new Response(validMp4, { status: 200, headers: { "Content-Type": "video/mp4" } });
    }
    return new Response("Not found", { status: 404 });
  };
  let driveUploaded = false;
  const mockDrive: any = {
    put: async () => {
      driveUploaded = true;
      return { fileId: `drive_file_${randomUUID()}`, name: "artifact.mp4", mimeType: "video/mp4", size: validMp4.byteLength, checksum: "sha" };
    },
    get: async () => ({ bytes: validMp4, mimeType: "video/mp4", name: "artifact.mp4" }),
    health: async () => ({ status: "HEALTHY", detail: "mock", latencyMs: 1 }),
  };

  const pollResult = await pollProductionJobs(sql, {
    organizationId: tenant.organizationId,
    fetchImpl: fakeFetch,
    driveClient: mockDrive,
    router: testRouter,
    limit: 10,
  });

  assert.equal(pollResult.claimed, 1);
  assert.equal(pollResult.rendered, 1);
  assert.equal(pollResult.failed, 0);

  // Durable state after the poll: the job is COMPLETED and materialized, and the creative is in review.
  const [job] = await sql<{ status: string; artifact_id: string | null; materialized_at: unknown }>`
    select status, artifact_id, materialized_at from production_jobs where id = ${jobId}
  `;
  assert.equal(job!.status, "COMPLETED");
  assert.ok(job!.artifact_id, "artifact is registered");
  assert.ok(job!.materialized_at, "artifact is materialized");
  const [asset] = await sql<{ media_status: string; qa_decision: string; review_status: string }>`
    select media_status, qa_decision, review_status from assets where id = ${`video-asset-${jobId}`}
  `;
  assert.equal(asset!.media_status, "completed");
  assert.notEqual(asset!.qa_decision, "auto_approved", "no automatic approval of an asynchronous artifact");
  assert.equal(asset!.review_status, "in_review");
  const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${`video-creative-${jobId}`}`;
  assert.equal(creative!.status, "in_review");
  const storage = await sql<{ n: number }>`select count(*)::int as n from storage_objects where organization_id = ${tenant.organizationId}`;
  assert.equal(Number(storage[0]!.n), 1);
  assert.equal(driveUploaded, true);
});

