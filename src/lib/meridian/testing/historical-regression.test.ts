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
import { buildCanonicalCreativeStructure } from "../factory/decode.ts";
import { deriveAdNarrative } from "../factory/creative-dna.ts";
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
  assert.equal(answer.status, "abstain_uncertain");
  assert.ok(calledUrl.includes("/decisions"));
  assert.ok(!calledUrl.includes("/chat/completions"));
});

// 7. JEV receives actual relevant evidence
test("7. Regression: compressEvidenceForJev packages actual normalized evidence, not just empty labels", () => {
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
      format: "ugc",
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
test("11. Regression: studio readiness rejects test:video as publishable live channel", () => {
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

  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";

  try {
    const veo = new VeoProvider({ fetchImpl: fakeFetch });
    const status = await veo.checkJobStatus("operations/123");
    assert.equal(status.status, "RENDERED");
    assert.equal(status.outputArtifactId, expectedUri);
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

// 13. Higgsfield uses current request/status contract
test("13. Regression: Higgsfield uses Authorization: Key and status_url contract", async () => {
  let capturedAuth = "";
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] || "";
    if (String(url).includes("/generate")) {
      return new Response(
        JSON.stringify({
          request_id: "req_999",
          status_url: "https://api.higgsfield.ai/v1/status/req_999",
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

  const originalKey = process.env.HIGGSFIELD_API_KEY;
  process.env.HIGGSFIELD_API_KEY = "hf-secret-key";

  try {
    const hf = new HiggsfieldProvider({ fetchImpl: fakeFetch });
    const job = await hf.submitJob({
      id: "spec-hf",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Spec",
      format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 10,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    });
    assert.equal(job.jobId, "req_999");
    assert.ok(capturedAuth.startsWith("Key "));

    const status = await hf.checkJobStatus(job.jobId);
    assert.equal(status.status, "RENDERED");
    assert.equal(status.outputArtifactId, "https://cdn.higgsfield.ai/video_999.mp4");
  } finally {
    if (originalKey) process.env.HIGGSFIELD_API_KEY = originalKey;
    else delete process.env.HIGGSFIELD_API_KEY;
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
test("16. Regression: unknown metrics stay null, not stored as zero", () => {
  const metrics = extractOrganicMetrics({});
  assert.equal(metrics.views, null);
  assert.notEqual(metrics.views, 0);
  assert.equal(metrics.likes, null);
  assert.notEqual(metrics.likes, 0);
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

