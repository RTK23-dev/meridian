import assert from "node:assert/strict";
import test from "node:test";
import { JevDecisionService } from "./service.ts";
import { JevRouter, TypeSafeDirectJevProvider } from "./router.ts";
import type { EvidenceBundle } from "../evidence/types.ts";
import { fixedLookup } from "../credentials/fixtures.ts";

const sampleCompleteBundle: EvidenceBundle = {
  id: "bundle-integration-123",
  organizationId: "org-1",
  brandId: "brand-1",
  source: {
    platform: "meta",
    sourceAdapter: "meta_ad_library",
    capturedAt: "2026-10-09T00:00:00Z",
    canonicalUrl: "https://facebook.com/ads/archive/123",
  },
  content: {
    type: "video",
    caption: "Stop scrolling if you want 10x ROI on your ads.",
  },
  provenance: {
    adapterId: "meta_ad_library",
    sourceUrl: "https://facebook.com/ads/archive/123",
    capturedAt: "2026-10-09T00:00:00Z",
  },
  availableEvidence: ["scene_frames", "transcript", "scene_cuts", "metadata", "claims"],
  transcript: [
    { id: "seg-1", text: "Stop scrolling if you want 10x ROI on your ads.", startMs: 0, endMs: 2500, confidence: 0.95 },
  ],
  // The scenes the bundle declares as scene_cuts and scene_frames. A declared name is evidence only when its structure is present.
  scenes: [
    { index: 0, startMs: 0, endMs: 2500, shotType: "close", facePresence: true, keyframeRef: "frame-0" },
    { index: 1, startMs: 2500, endMs: 5000, shotType: "wide", facePresence: false },
  ],
  metrics: {
    durationMs: 15000,
  },
  evidenceRefs: [
    { field: "transcript", artifactId: "bundle-integration-123" },
    { field: "metadata", artifactId: "bundle-integration-123" },
  ],
  createdAt: "2026-10-09T00:00:00Z",
};

test("JevDecisionService: dispatches typed evidence to TypeSafe provider via intercepted fetch", async () => {
  let callCount = 0;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const bodies: any[] = [];

  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    callCount++;
    capturedUrl = String(url);
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    bodies.push(JSON.parse(String(init?.body || "{}")));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "typesafe/jev-1.13",
        inputHash: "hash-ts-123",
        answers: {
          "organic.hook_mechanism.v1": {
            choice: "pattern_interrupt",
            confidence: 0.92,
            evidenceRefs: [{ field: "transcript", artifactId: "bundle-integration-123" }],
          },
          "organic.format_structure.v1": {
            choice: "talking_head_demo",
            confidence: 0.85,
            evidenceRefs: [{ field: "transcript", artifactId: "bundle-integration-123" }],
          },
        },
      }),
    } as unknown as Response;
  };

  const router = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({
      lookup: fixedLookup("test_typesafe_key"),
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      fetchImpl: mockFetch as typeof fetch,
    }),
  });

  const service = new JevDecisionService(router);

  const result = await service.evaluateEvidence({
    organizationId: "org-1",
    brandId: "brand-1",
    bundle: sampleCompleteBundle,
    questionIds: ["organic.hook_mechanism.v1", "organic.format_structure.v1"],
    policy: { mode: "typesafe_direct" },
  });

  // One call per evidence scope. The two questions declare different scopes, so there are two calls, each with one question.
  assert.equal(callCount, 2);
  assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(capturedHeaders["Authorization"], "Bearer test_typesafe_key");
  assert.equal(capturedHeaders["Content-Type"], "application/json");

  const hookBody = bodies.find((body) => body.questions["organic.hook_mechanism.v1"]);
  const formatBody = bodies.find((body) => body.questions["organic.format_structure.v1"]);
  assert.ok(hookBody && formatBody, "each question is sent");
  assert.deepEqual(Object.keys(hookBody.questions), ["organic.hook_mechanism.v1"], "the hook call carries only the hook question");
  assert.deepEqual(Object.keys(formatBody.questions), ["organic.format_structure.v1"], "the format call carries only the format question");

  // The bundle's identity and source reach each call inside its own scope, as bundle_source.
  assert.equal(hookBody.state.evidence.bundle_source.bundleId, "bundle-integration-123");
  assert.equal(hookBody.state.evidence.bundle_source.source.sourceAdapter, "meta_ad_library");
  assert.deepEqual([...hookBody.state.availableEvidence].sort(), ["bundle_source", "scene_frames", "transcript"]);
  assert.deepEqual([...formatBody.state.availableEvidence].sort(), ["bundle_source", "scene_cuts", "transcript"]);
  assert.ok(hookBody.state.availableEvidence.includes("transcript"));

  assert.equal(result.provider, "typesafe_direct");
  assert.equal(result.answers.length, 2);

  const hookAns = result.answers.find((a) => a.questionId === "organic.hook_mechanism.v1");
  assert.ok(hookAns);
  assert.equal(hookAns.status, "answered");
  assert.equal(hookAns.choice, "pattern_interrupt");
  assert.equal(hookAns.confidence, 0.92);

  const formatAns = result.answers.find((a) => a.questionId === "organic.format_structure.v1");
  assert.ok(formatAns);
  assert.equal(formatAns.status, "answered");
  assert.equal(formatAns.choice, "talking_head_demo");
});

test("JevDecisionService: abstains with typed reason and skips network dispatch when required evidence is missing", async () => {
  let callCount = 0;
  const mockFetch = async (): Promise<Response> => {
    callCount++;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  };

  const router = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({
      lookup: fixedLookup("test_typesafe_key"),
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      fetchImpl: mockFetch as typeof fetch,
    }),
  });
  const service = new JevDecisionService(router);

  // Bundle lacks "scene_frames", which is required by organic.hook_mechanism.v1
  const deficientBundle: EvidenceBundle = {
    ...sampleCompleteBundle,
    availableEvidence: ["transcript"],
  };

  const result = await service.evaluateEvidence({
    organizationId: "org-1",
    brandId: "brand-1",
    bundle: deficientBundle,
    questionIds: ["organic.hook_mechanism.v1"],
    policy: { mode: "typesafe_direct" },
  });

  assert.equal(callCount, 0, "Network fetch must not be dispatched when evidence is deficient");
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].status, "abstain_insufficient_evidence");
  assert.ok(result.answers[0].abstainReason?.includes("Missing required evidence: scene_frames"));
});

test("JevDecisionService: persists decisions and answers to SQL ledger when SQL client is supplied", async () => {
  const executedQueries: Array<{ sql: string; values: any[] }> = [];

  const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    executedQueries.push({ sql: strings.join("?"), values });
    return Promise.resolve([]);
  };

  const mockFetch = async (): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "typesafe/jev-1.13",
        inputHash: "sql-hash-1",
        answers: {
          "organic.hook_mechanism.v1": {
            choice: "pattern_interrupt",
            confidence: 0.88,
            evidenceRefs: [],
          },
        },
      }),
    } as unknown as Response;
  };

  const router = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({
      lookup: fixedLookup("test_typesafe_key"),
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      fetchImpl: mockFetch as typeof fetch,
    }),
  });

  const service = new JevDecisionService(router);

  const result = await service.evaluateEvidence({
    organizationId: "org-1",
    brandId: "brand-1",
    bundle: sampleCompleteBundle,
    questionIds: ["organic.hook_mechanism.v1"],
    policy: { mode: "typesafe_direct" },
    sql: mockSql,
  });

  assert.equal(result.persisted, true);
  // The active engine is looked up first, so the ledger writes are found by their statements, not their position.
  assert.ok(executedQueries.length >= 2, "Must execute insert into jev_runs and jev_answers");
  assert.ok(executedQueries.some((query) => query.sql.includes("insert into jev_runs")));
  assert.ok(executedQueries.some((query) => query.sql.includes("insert into jev_answers")));
});
