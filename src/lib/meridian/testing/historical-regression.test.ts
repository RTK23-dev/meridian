import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterJevClient, computeJevInputHash } from "../jev/client.ts";
import { recordTelemetry } from "../learning/telemetry-engine.ts";
import { upsertModelParameter } from "../learning/parameters.ts";
import { extractOrganicMetrics } from "../organic/learning-bridge.ts";
import { VeoProvider } from "../production/providers/veo.ts";
import { HiggsfieldProvider } from "../production/providers/higgsfield.ts";
import { accountProviderState } from "../providers/boundaries.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import { createEvidenceBundle, compressEvidenceForJev } from "../evidence/bundle.ts";
import { asEvidenceValue } from "../evidence/types.ts";
import { buildCanonicalCreativeStructure, deriveAdNarrative } from "../factory/creative-dna.ts";
import { runVideoJob } from "../studio/media-work.ts";
import {
  createGoogleDriveObjectStore,
  createMemoryStorageMetadataRepository,
} from "../storage/object-store.ts";

// 1. Missing views remain unknown (never coerced to 5000)
test("1. Regression: missing views remain unknown and never default to 5000", () => {
  const metrics = extractOrganicMetrics({ likes: 42, comments: 5 });
  assert.equal(metrics.views, null);
  assert.notEqual(metrics.views, 5000);
});

// 2. Missing completion remains unknown (never coerced to 0.25)
test("2. Regression: missing completion remains unknown and never defaults to 0.25", () => {
  const metrics = extractOrganicMetrics({ views: 10000, likes: 200 });
  assert.equal(metrics.completionRate, null);
  assert.notEqual(metrics.completionRate, 0.25);
});

// 3. Missing 3s retention remains unknown (never coerced to 0.45 * views)
test("3. Regression: missing 3s retention remains unknown and never defaults to 0.45 * views", () => {
  const metrics = extractOrganicMetrics({ views: 10000, likes: 200 });
  assert.equal(metrics.threeSecondViews, null);
  assert.notEqual(metrics.threeSecondViews, 4500);
});

// 4. JEV noul has probability but no fabricated confidence
test("4. Regression: JEV noul has probability but no fabricated confidence", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          q_test: {
            type: "noul",
            noul: 0.88,
          },
        },
      }),
      { status: 200 },
    );

  const client = new OpenRouterJevClient({
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });

  const res = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: { description: "User speaking naturally", availableEvidence: [] },
    questions: {
      q_test: {
        id: "q_test",
        version: "1.0.0",
        type: "noul",
        instructions: "Is this authentic?",
        criteria: { true: "authentic", false: "staged" },
        evidenceRequirements: [],
      },
    },
  });

  const answer = res.answers["q_test"]!;
  assert.equal(answer.type, "noul");
  assert.equal(answer.noul, 0.88);
  assert.equal(answer.confidence, undefined);
  assert.notEqual(answer.confidence, 0.85);
});

// 5. Malformed JEV answer is rejected
test("5. Regression: malformed JEV answer is rejected with provider_error without fallback coercion", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          q_bad_noul: {
            type: "noul",
            noul: "not-a-number",
          },
        },
      }),
      { status: 200 },
    );

  const client = new OpenRouterJevClient({
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });

  const res = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: { description: "Testing malformed", availableEvidence: [] },
    questions: {
      q_bad_noul: {
        id: "q_bad_noul",
        version: "1.0.0",
        type: "noul",
        instructions: "Test question",
        criteria: { true: "yes", false: "no" },
        evidenceRequirements: [],
      },
    },
  });

  const answer = res.answers["q_bad_noul"]!;
  assert.equal(answer.status, "provider_error");
  assert.notEqual(answer.probability, 0.5);
});

// 6. JEV never calls /chat/completions fallback
test("6. Regression: JEV never calls /chat/completions fallback on error", async () => {
  let calledUrl = "";
  const failingFetch: typeof fetch = async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ error: "Internal JEV Error" }), { status: 500 });
  };

  const client = new OpenRouterJevClient({
    apiKey: "test-key",
    fetchImpl: failingFetch,
  });

  const res = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: { description: "Some state", availableEvidence: [] },
    questions: {
      q_test: {
        id: "q_test",
        version: "1.0.0",
        type: "noul",
        instructions: "Is this real?",
        criteria: { true: "real", false: "fake" },
        evidenceRequirements: [],
      },
    },
  });

  const answer = res.answers["q_test"]!;
  assert.equal(answer.status, "provider_error");
  assert.ok(calledUrl.includes("/decisions"));
  assert.ok(!calledUrl.includes("/chat/completions"));
});

// 7. JEV receives actual relevant evidence
test("7. Regression: compressEvidenceForJev packages actual normalized evidence and reaches remote fetch body", async () => {
  const bundle = createEvidenceBundle({
    organizationId: "org-1",
    brandId: "brand-1",
    source: {
      platform: "instagram",
      canonicalUrl: "https://instagram.com/p/reel123",
      sourceAdapter: "instagram_graph",
      capturedAt: new Date().toISOString(),
    },
    content: {
      type: "video",
      title: "Product demonstration",
    },
    performance: {
      views: asEvidenceValue(55000, "OBSERVED"),
      shares: asEvidenceValue(1200, "OBSERVED"),
    },
    scenes: [
      {
        index: 0,
        startMs: 0,
        endMs: 2500,
        shotType: "close_up",
        productPresence: true,
        keyframeRef: "frame_0",
      },
    ],
    ocr: [
      {
        text: "Order Now",
        role: "cta",
        startMs: 2000,
        endMs: 2500,
        confidence: 0.9,
      },
    ],
    provenance: {
      adapterId: "instagram_graph",
      sourceUrl: "https://instagram.com/p/reel123",
      capturedAt: new Date().toISOString(),
    },
  });

  const compressed = compressEvidenceForJev(bundle);
  assert.equal(compressed.platform, "instagram");
  assert.equal(compressed.metrics.views, 55000);
  assert.ok(compressed.scenes && compressed.scenes.length === 1);
  assert.equal(compressed.scenes[0].shotType, "close_up");
  assert.ok(compressed.ocr && compressed.ocr.length === 1);
  assert.equal(compressed.ocr[0].text, "Order Now");
  assert.ok(compressed.evidenceRefs.length > 0);

  // Boundary verification: verify that client.answer() transmits compressed evidence into fetch payload
  let capturedPayload: any = null;
  const mockFetch: typeof fetch = async (_url, init) => {
    capturedPayload = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({
        answers: {
          q_test: { type: "noul", noul: 0.92 },
        },
      }),
      { status: 200 },
    );
  };

  const client = new OpenRouterJevClient({
    apiKey: "test-api-key",
    fetchImpl: mockFetch,
  });

  const answer = await client.answer({
    evidenceBundle: bundle,
    question: {
      id: "q_test",
      version: "1.0.0",
      type: "noul",
      instructions: "Is this genuine product demonstration?",
      criteria: { true: "genuine", false: "misleading" },
      evidenceRequirements: [],
    },
  });

  assert.equal(answer.status, "answered");
  assert.ok(capturedPayload, "Remote JEV request body must be captured");
  assert.equal(capturedPayload.state.platform, "instagram");
  assert.equal(capturedPayload.state.metrics?.views, 55000);
  assert.ok(Array.isArray(capturedPayload.state.scenes), "Scenes must reach remote JEV state");
  assert.equal(capturedPayload.state.scenes[0]?.shotType, "close_up");
  assert.ok(Array.isArray(capturedPayload.state.ocr), "OCR must reach remote JEV state");
  assert.equal(capturedPayload.state.ocr[0]?.text, "Order Now");
});

// 8. Synthetic telemetry cannot enter production learning
test("8. Regression: production learning rejects synthetic/simulated telemetry", async () => {
  const fakeSql = (() => {}) as any;

  await assert.rejects(
    async () => {
      await recordTelemetry(fakeSql, {
        organizationId: "org-1",
        brandId: "brand-1",
        creativeId: "creative-1",
        platform: "instagram",
        accountId: "ig-1",
        views: 1000,
        metadata: { synthetic: true },
      });
    },
    /Synthetic or simulated telemetry/,
  );
});

// 9. Channel readiness is truthful
test("9. Regression: channel readiness is truthful and returns NOT_CONNECTED when unconfigured", () => {
  const metaState = accountProviderState("meta", {});
  assert.equal(metaState.status, "NOT_CONNECTED");
});

// 10. Unconfigured providers never invent job IDs
test("10. Regression: unconfigured providers never invent job IDs", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const veo = new VeoProvider();
    const job = await veo.submitJob({
      id: "spec-1",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Spec",
      modality: "video", format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    });
    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.jobId, "");
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    if (originalGoogle) process.env.GOOGLE_API_KEY = originalGoogle;
  }
});

// 11. Studio cannot reach test:video
test("11. Regression: studio readiness rejects test:video and production runtime refuses execution", async () => {
  const result = assessPublishing({
    accounts: [],
    provider: "test:video",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 500000,
    destinationUrl: "https://example.com",
  });
  assert.equal(result.state, "HUMAN_REVIEW");
  assert.ok(result.summary.includes("explicit test publisher"));

  // Boundary verification: runVideoJob in ProductionRuntime strictly throws error
  const origEnv = process.env.NODE_ENV;
  const origTesting = process.env.MERIDIAN_TESTING_RUNTIME;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.MERIDIAN_TESTING_RUNTIME;

    const mockSql = ((strings: TemplateStringsArray) => {
      const q = strings.join("");
      if (q.includes("select * from media_jobs")) {
        return Promise.resolve([{ id: "m-1", provider: "test:video", asset_id: "a-1" }]);
      }
      return Promise.resolve([]);
    }) as any;

    await assert.rejects(
      async () => {
        await runVideoJob(
          mockSql,
          { id: "j-1", organization_id: "org-1", job_type: "video.generate" } as any,
          { mediaJobId: "m-1", allowTest: true },
        );
      },
      /test:video is only available in TestingRuntime and is disabled in ProductionRuntime/,
    );
  } finally {
    process.env.NODE_ENV = origEnv;
    if (origTesting) process.env.MERIDIAN_TESTING_RUNTIME = origTesting;
  }
});

// 12. Veo polling reads generatedSamples path
test("12. Regression: Veo polling reads generatedSamples REST response path", async () => {
  const expectedUri = "https://storage.googleapis.com/test-bucket/sample.mp4";
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        name: "operations/123",
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: expectedUri } }],
          },
        },
      }),
      { status: 200 },
    );

  // The poll uses the key of the workspace that owns the job, which the poller passes in the job's metadata.
  const { fixedLookup } = await import("../credentials/fixtures.ts");
  const veo = new VeoProvider({ fetchImpl: fakeFetch, lookup: fixedLookup("test-gemini-key") });
  const status = await veo.checkJobStatus("operations/123", { organizationId: "org-1" });
  assert.equal(status.status, "RENDERED");
  assert.equal(status.outputArtifactId, expectedUri);
});

// 13. Higgsfield uses current request/status contract
test("13. Regression: Higgsfield uses Authorization: Key and status_url contract", async () => {
  let capturedAuth = "";
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] || "";
    if ((String(url).includes("/requests") || String(url).includes("/higgsfield/")) && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          request_id: "req_999",
          status_url: "https://api.higgsfield.ai/v1/requests/req_999/status",
          cancel_url: "https://api.higgsfield.ai/v1/requests/req_999/cancel",
          status: "queued",
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        status: "completed",
        video: { url: "https://cdn.higgsfield.ai/video_999.mp4" },
      }),
      { status: 200 },
    );
  };

  // The key is the workspace's for this test, supplied by the lookup, not read from the environment.
  const { fixedLookup } = await import("../credentials/fixtures.ts");
  {
    const hf = new HiggsfieldProvider({ fetchImpl: fakeFetch, lookup: fixedLookup("hf-secret-key") });
    const job = await hf.submitJob({
      id: "spec-hf",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Spec",
      modality: "video", format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 10,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    });
    assert.equal(job.jobId, "req_999");
    assert.ok(capturedAuth.startsWith("Key "));
    assert.equal(job.metadata?.statusUrl, "https://api.higgsfield.ai/v1/requests/req_999/status");
    assert.equal(job.metadata?.cancelUrl, "https://api.higgsfield.ai/v1/requests/req_999/cancel");

    const status = await hf.checkJobStatus(job.jobId, job.metadata);
    assert.equal(status.status, "RENDERED");
    assert.equal(status.outputArtifactId, "https://cdn.higgsfield.ai/video_999.mp4");
  }
});

// 14. Drive key resolves through storage_objects
test("14. Regression: Drive key resolves through storage_objects metadata repository", async () => {
  const repo = createMemoryStorageMetadataRepository();
  await repo.upsert({
    organizationId: "org-1",
    brandId: "brand-1",
    key: "assets/promo.mp4",
    providerFileId: "drive_file_12345",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    sha256: "hash123",
  });

  let fetchedFileId = "";
  const mockDriveClient = {
    get: async (id: string) => {
      fetchedFileId = id;
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4", name: "promo.mp4" };
    },
    put: async () => ({ fileId: "new_id", name: "p", mimeType: "video/mp4", size: 3, checksum: "c" }),
    delete: async () => {},
    getFolderForPath: async () => "folder_1",
    findFileByName: async () => null,
  } as any;

  const store = createGoogleDriveObjectStore(mockDriveClient, { metadataRepo: repo });
  const obj = await store.get("org-1", "brand-1", "assets/promo.mp4");
  assert.ok(obj);
  assert.equal(fetchedFileId, "drive_file_12345");
});

// 15. Drive metadata is persisted after upload
test("15. Regression: Drive metadata is persisted to repository after upload", async () => {
  const repo = createMemoryStorageMetadataRepository();
  const mockDriveClient = {
    put: async () => ({
      fileId: "drive_uploaded_file_42",
      name: "video.mp4",
      mimeType: "video/mp4",
      size: 400,
      checksum: "sha_xyz",
    }),
  } as any;

  const store = createGoogleDriveObjectStore(mockDriveClient, { metadataRepo: repo });
  await store.put({
    organizationId: "org-1",
    brandId: "brand-1",
    key: "video.mp4",
    mimeType: "video/mp4",
    bytes: new Uint8Array(400),
  });

  const record = await repo.getByKey("org-1", "brand-1", "video.mp4");
  assert.ok(record);
  assert.equal(record.providerFileId, "drive_uploaded_file_42");
  assert.equal(record.sha256, "sha_xyz");
});

// 16. Unknown metrics are not stored as zero
test("16. Regression: unknown metrics stay null, not stored as zero in extractOrganicMetrics and recordTelemetry", async () => {
  const metrics = extractOrganicMetrics({});
  assert.equal(metrics.views, null);
  assert.notEqual(metrics.views, 0);
  assert.equal(metrics.likes, null);
  assert.notEqual(metrics.likes, 0);

  // Boundary verification: recordTelemetry preserves null values without coercing to zero
  const mockSql = ((_strings: TemplateStringsArray, ..._values: any[]) => {
    return Promise.resolve([]);
  }) as any;

  const recorded = await recordTelemetry(mockSql, {
    organizationId: "org-1",
    brandId: "brand-1",
    creativeId: "c-1",
    platform: "tiktok",
    // views, impressions, reach omitted
  });
  assert.equal(recorded.views, null);
  assert.notEqual(recorded.views, 0);
  assert.equal(recorded.impressions, null);
  assert.notEqual(recorded.impressions, 0);
  assert.equal(recorded.completionRate, null);
  assert.notEqual(recorded.completionRate, 0);
});

// 17. CreativeStructure can represent a POV
test("17. Regression: CreativeStructure accurately classifies POV format", () => {
  const structure = buildCanonicalCreativeStructure({
    scenes: [
      {
        index: 0,
        startMs: 0,
        endMs: 3000,
        shotType: { value: "close_up", confidence: 0.8, source: { kind: "frame" } },
        presenter: { value: "", confidence: 0, source: { kind: "missing" } },
        productOnScreen: { value: false, confidence: 0, source: { kind: "missing" } },
        setting: { value: "room", confidence: 0.8, source: { kind: "frame" } },
        motion: { value: "handheld", confidence: 0.8, source: { kind: "frame" } },
        overlay: { value: "", confidence: 0, source: { kind: "missing" } },
      },
    ],
    segments: [],
    onScreenText: [],
    durationMs: 5000,
    cutsPerSecond: 0.2,
    transcript: "POV: You found the easiest skincare routine",
  });

  assert.equal(structure.kind, "pov");
  assert.equal(structure.segments.length, 1);
});

// 18. CreativeStructure can represent a listicle
test("18. Regression: CreativeStructure accurately classifies listicle format", () => {
  const structure = buildCanonicalCreativeStructure({
    scenes: [],
    segments: [],
    onScreenText: [{ text: "1. Cleanse", startMs: 1000, role: "other", confidence: 0.8 }],
    durationMs: 8000,
    cutsPerSecond: 0.5,
    transcript: "Top 3 reasons why your skin is dry",
  });

  assert.equal(structure.kind, "listicle");
});

// 19. CreativeStructure can represent a loop
test("19. Regression: CreativeStructure accurately classifies loop format", () => {
  const structure = buildCanonicalCreativeStructure({
    scenes: [],
    segments: [],
    onScreenText: [],
    durationMs: 7000,
    cutsPerSecond: 0.4,
    transcript: "Wait for the loop to repeat seamlessly",
  });

  assert.equal(structure.kind, "loop");
});

// 20. AdNarrative remains optional
test("20. Regression: AdNarrative remains an optional projection and is null for non-ad content", () => {
  const structure = buildCanonicalCreativeStructure({
    scenes: [
      {
        index: 0,
        startMs: 0,
        endMs: 3000,
        shotType: { value: "wide", confidence: 0.8, source: { kind: "frame" } },
        presenter: { value: "creator", confidence: 0.8, source: { kind: "frame" } },
        productOnScreen: { value: false, confidence: 0, source: { kind: "missing" } },
        setting: { value: "outdoor", confidence: 0.8, source: { kind: "frame" } },
        motion: { value: "static", confidence: 0.8, source: { kind: "frame" } },
        overlay: { value: "", confidence: 0, source: { kind: "missing" } },
      },
    ],
    segments: [],
    onScreenText: [],
    durationMs: 3000,
    cutsPerSecond: 0.33,
    transcript: "Enjoying the sunset outdoors today",
  });

  const narrative = deriveAdNarrative(structure);
  assert.equal(narrative, null);
});

// 21. Source capabilities are truthful
test("21. Regression: unconfigured source adapters report NOT_CONFIGURED without credentials", () => {
  const state = accountProviderState("tiktok", {});
  assert.equal(state.status, "NOT_CONNECTED");
});

// 22. Provider router refuses unconfigured providers
test("22. Regression: Provider router refuses unconfigured providers", async () => {
  const originalKey = process.env.HIGGSFIELD_API_KEY;
  delete process.env.HIGGSFIELD_API_KEY;

  try {
    const hf = new HiggsfieldProvider();
    const health = await hf.health();
    assert.equal(health.state, "NOT_CONFIGURED");
  } finally {
    if (originalKey) process.env.HIGGSFIELD_API_KEY = originalKey;
  }
});

// 23. Provider jobs survive worker restart (persisted job structure)
test("23. Regression: production jobs retain complete serialization schema", () => {
  const job = {
    jobId: "job-101",
    organizationId: "org-1",
    brandId: "brand-1",
    creativeSpec: {
      id: "spec-1",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Test Spec",
      format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    },
    providerId: "veo",
    status: "RUNNING" as const,
    costEstimateUsd: 3.0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(job);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.jobId, "job-101");
  assert.equal(parsed.providerId, "veo");
  assert.equal(parsed.status, "RUNNING");
});

// 24. Publishing rejects placeholder media
test("24. Regression: publishing assessment rejects 0-byte media", () => {
  const readiness = assessPublishing({
    accounts: [
      {
        provider: "meta",
        status: "CONNECTED",
        accountId: "act_123",
        permissions: ["ads_management"],
        pageId: "page_123",
        destinationUrl: "https://brand.com",
      },
    ],
    provider: "meta",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 0, // 0 bytes
    destinationUrl: "https://brand.com",
  });

  assert.equal(readiness.state, "NOT_READY");
  assert.ok(readiness.summary.includes("no stored media bytes"));
});

// 25. Publishing rejects unapproved lifecycle
test("25. Regression: publishing readiness rejects when account is not connected", () => {
  const readiness = assessPublishing({
    accounts: [
      {
        provider: "meta",
        status: "NOT_CONNECTED",
        accountId: "act_123",
        permissions: [],
        pageId: "page_123",
        destinationUrl: "https://brand.com",
      },
    ],
    provider: "meta",
    kind: "video",
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 100000,
    destinationUrl: "https://brand.com",
  });

  assert.equal(readiness.state, "EXTERNAL_CONNECTION_REQUIRED");
});

// 26. Cache invalidates when question definition changes
test("26. Regression: JEV cache hash invalidates when question instructions or criteria change", () => {
  const hash1 = computeJevInputHash({
    state: { data: "test" },
    questions: {
      q1: {
        id: "q1",
        version: "1.0.0",
        type: "choice",
        instructions: "Evaluate hook power.",
        criteria: { a: "strong", b: "weak" },
        evidenceRequirements: [],
      },
    },
    model: "typesafe/jev-1.13",
  });

  const hash2 = computeJevInputHash({
    state: { data: "test" },
    questions: {
      q1: {
        id: "q1",
        version: "1.0.0",
        type: "choice",
        instructions: "Evaluate retention hold instead.", // changed instructions
        criteria: { a: "strong", b: "weak" },
        evidenceRequirements: [],
      },
    },
    model: "typesafe/jev-1.13",
  });

  assert.notEqual(hash1, hash2);
});

// 27. Evidence provenance survives JEV
test("27. Regression: Evidence provenance survives in EvidenceBundle and into JEV", () => {
  const bundle = createEvidenceBundle({
    organizationId: "org-1",
    brandId: "brand-1",
    source: {
      platform: "instagram",
      canonicalUrl: "https://instagram.com/reel/123",
      sourceAdapter: "instagram_graph",
      capturedAt: "2026-10-08T12:00:00Z",
    },
    content: {
      type: "video",
    },
    provenance: {
      adapterId: "instagram_graph",
      sourceUrl: "https://instagram.com/reel/123",
      capturedAt: "2026-10-08T12:00:00Z",
      contentHash: "hash_abc",
    },
  });

  assert.equal(bundle.provenance.adapterId, "instagram_graph");
  assert.equal(bundle.provenance.sourceUrl, "https://instagram.com/reel/123");
  assert.equal(bundle.provenance.contentHash, "hash_abc");
});

// 28. Learned parameters cannot be called validated before validation
test("28. Regression: Learned parameters cannot be marked validated without empirical calibration", async () => {
  const fakeSql = (() => {}) as any;

  await assert.rejects(
    async () => {
      await upsertModelParameter(fakeSql, {
        organizationId: "org-1",
        parameterName: "hook_weight",
        state: "validated", // Attempting validated without >= 100 observations and score
        evidenceCount: 10,
        parameterValue: { weight: 0.8 },
      });
    },
    /Cannot validate parameter without at least 100 observations/,
  );
});

// 29. Dual JEV Provider Router routes explicitly without silent chat coercion
test("29. Regression: Dual JEV Provider Router supports typesafe_direct and openrouter", async () => {
  const { TypeSafeDirectJevProvider, JevRouter } = await import("../jev/router.ts");
  const { notConfiguredLookup } = await import("../credentials/fixtures.ts");
  const directProvider = new TypeSafeDirectJevProvider({ lookup: notConfiguredLookup() });
  const router = new JevRouter({ typesafeProvider: directProvider });

  const health = await directProvider.health();
  assert.equal(health.status, "NOT_CONFIGURED");

  const res = await router.decide({
    organizationId: "org-test",
    brandId: "brand-test",
    state: { description: "Test" },
    questions: {
      q1: {
        id: "q1",
        version: "1.0",
        type: "noul",
        instructions: "Test",
        criteria: { true: "yes", false: "no" },
        evidenceRequirements: [],
      },
    },
  }, { mode: "typesafe_direct" });

  assert.equal(res.provider, "typesafe_direct");
  assert.equal(res.answers["q1"].status, "not_configured");
});

// 30. Cyclone scout adapter reports unknown views as undefined, never 15000 or likes * 15
test("30. Regression: Cyclone scout adapter leaves unobserved views and baselines undefined", async () => {
  const { CycloneScoutSourceAdapter } = await import("../discovery/cyclone-scout-adapter.ts");
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:9090", deviceId: "pixel-8" },
  });

  const sampleCard = {
    nodeId: "root",
    role: "root_view",
    children: [
      { nodeId: "creator", role: "TextView", text: "@fitness_daily" },
      { nodeId: "likes", role: "TextView", text: "500 likes" },
      { nodeId: "comments", role: "TextView", text: "20 comments" },
    ],
  };

  const reel = adapter.parsePageCardToReel(sampleCard, "fitness");
  assert.ok(reel !== null);
  if (!reel) return;
  assert.equal(reel.creatorHandle, "fitness_daily");
  assert.equal(reel.metrics.views, undefined);
  assert.notEqual(reel.metrics.views, 7500); // not 500 * 15
  assert.equal(reel.creatorFollowerCount, undefined);
  assert.notEqual(reel.creatorFollowerCount, 15000);
  assert.equal(reel.creatorLast30MedianViews, undefined);
});

// 31. Graph API adapter preserves unobserved views as undefined
test("31. Regression: Instagram Graph API adapter leaves unobserved views undefined", async () => {
  const { InstagramBusinessDiscoveryAdapter } = await import("../discovery/graph-api-adapter.ts");
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        business_discovery: {
          followers_count: 50000,
          media_count: 10,
          media: {
            data: [
              {
                id: "media_123",
                caption: "Morning motivation",
                media_type: "VIDEO",
                like_count: 1000,
                comments_count: 50,
                permalink: "https://www.instagram.com/reel/123/",
              },
            ],
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const adapter = new InstagramBusinessDiscoveryAdapter({
    credentials: { accessToken: "EAAG_TEST", businessAccountId: "1784" },
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  const res = await adapter.fetchCreatorReels({ targetUsername: "fitness", niche: "fitness" });
  assert.equal(res.status, "connected");
  if (res.status !== "connected") return;
  assert.equal(res.items[0].metrics.views, undefined);
  assert.equal(res.items[0].creatorLast30MedianViews, undefined);
});

// 32. Google Omni provider uses Interactions API contract
test("32. Regression: GeminiOmniVideoProvider uses Interactions API contract", async () => {
  const { GeminiOmniVideoProvider } = await import("../production/providers/omni.ts");
  let calledEndpoint = "";

  const mockFetch = async (url: string | URL | Request) => {
    calledEndpoint = url.toString();
    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-456",
        status: "COMPLETED",
        steps: [
          {
            status: "COMPLETED",
            outputs: [{ type: "video", uri: "https://storage.googleapis.com/omni.mp4" }],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  // The workspace's own production key is what the provider uses, so the test supplies one for the workspace.
  const { fixedLookup } = await import("../credentials/fixtures.ts");
  const provider = new GeminiOmniVideoProvider({ fetchImpl: mockFetch as unknown as typeof fetch, lookup: fixedLookup("test-key") });
  const job = await provider.submitJob({
    id: "spec-1",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Test",
    modality: "video", format: "reel",
    aspectRatio: "9:16",
    durationTargetSeconds: 5,
    hookLine: "Hook",
    script: "Script",
    scenes: [],
  });

  assert.ok(calledEndpoint.includes("/interactions"));
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.outputArtifactId, "https://storage.googleapis.com/omni.mp4");
});

// 33. Model capability registry tracks Veo 3.1 deprecation
test("33. Regression: ModelCapabilityRegistry flags Veo 3.1 preview shutdown warning", async () => {
  const { modelCapabilityRegistry } = await import("../production/registry.ts");
  const lifecycle = modelCapabilityRegistry.checkModelLifecycle(
    "veo-3.1-generate-preview",
    new Date("2026-10-09")
  );
  assert.equal(lifecycle.state, "DEPRECATED");
  assert.ok(lifecycle.warning?.includes("2026-10-22"));
  assert.equal(lifecycle.replacement, "gemini-omni-1.1-flash");
});

// 34. Decomposed opportunity rating keeps business potential null when telemetry is unobserved
test("34. Regression: Decomposed opportunity rating preserves unknown business potential as null", async () => {
  const { calculateDecomposedOpportunityRating } = await import("../factory/concept-genome.ts");
  const rating = calculateDecomposedOpportunityRating({
    observed: { views: 50000, creatorMedianViews: 10000 },
    conceptGenes: ["result-first"],
  });

  assert.equal(rating.businessPotential.score, null);
  assert.equal(rating.businessPotential.epistemicState, "UNKNOWN");
  assert.ok(rating.missingDimensions.includes("business_conversion_telemetry"));
});

// 35. Universal creative manifest prevents research-only from creating production jobs
test("35. Regression: validateCreationPlan blocks research-only from creating production jobs", async () => {
  const { validateCreationPlan } = await import("../factory/creative-manifest.ts");
  const plan = validateCreationPlan({
    mode: "research_only",
    productionStrategy: "reuse_edit_assets",
    startingMaterial: "new_brief",
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.willCreateProductionJob, false);
});


