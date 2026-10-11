import assert from "node:assert/strict";
import test from "node:test";
import {
  TypeSafeDirectJevProvider,
  JevRouter,
} from "./router.ts";
import type {
  JevDecisionRequest,
  JevDecisionResponse,
  JevProvider,
} from "./types.ts";
import { fixedLookup, notConfiguredLookup } from "../credentials/fixtures.ts";

const sampleRequest: JevDecisionRequest = {
  organizationId: "org-test",
  brandId: "brand-test",
  state: {
    description: "Sample test creative",
  },
  questions: {
    "test.hook": {
      id: "test.hook",
      version: "1.0",
      type: "noul",
      instructions: "Is this a scroll stopper?",
      criteria: { true: "yes", false: "no" },
      evidenceRequirements: [],
    },
    "test.choice": {
      id: "test.choice",
      version: "1.0",
      type: "choice",
      instructions: "Which format is this?",
      options: ["ugc", "demo"],
      criteria: { ugc: "user generated content", demo: "product demonstration" },
      evidenceRequirements: [],
    },
    "test.score": {
      id: "test.score",
      version: "1.0",
      type: "score",
      instructions: "Rate creative craft",
      criteria: { high: "10", low: "1" },
      evidenceRequirements: [],
    },
  },
};

test("TypeSafeDirectJevProvider reports NOT_CONFIGURED when API key is missing", async () => {
  const provider = new TypeSafeDirectJevProvider({ lookup: notConfiguredLookup() });
  const health = await provider.health();
  assert.equal(health.status, "NOT_CONFIGURED");
  assert.equal((await provider.healthFor("org-test")).status, "NOT_CONFIGURED");

  const res = await provider.decide(sampleRequest);
  assert.equal(res.provider, "typesafe_direct");
  assert.equal(res.answers["test.hook"].status, "not_configured");
});

test("TypeSafeDirectJevProvider calls /v1/systemone with Bearer token and parses choice/score/noul answers", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: any = null;

  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBody = JSON.parse(String(init?.body || "{}"));

    return new Response(
      JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          "test.hook": {
            noul: 0.85,
            evidenceRefs: [],
          },
          "test.choice": {
            choice: "ugc",
            probabilities: { ugc: 0.9, demo: 0.1 },
            confidence: 0.92,
            evidenceRefs: [],
          },
          "test.score": {
            score: 8.5,
            probabilities: { "8": 0.7, "9": 0.3 },
            confidence: 0.88,
            legend: { "8": "Strong", "9": "Exceptional" },
            evidenceRefs: [],
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const provider = new TypeSafeDirectJevProvider({
    lookup: fixedLookup("test-typesafe-key-123"),
    fetchImpl: fakeFetch,
  });

  const res = await provider.decide(sampleRequest);

  assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(capturedHeaders["Authorization"], "Bearer test-typesafe-key-123");
  assert.equal(capturedBody.model, "typesafe/jev-1.13");
  assert.ok(capturedBody.questions["test.hook"]);

  // Verify answer parsing
  assert.equal(res.answers["test.hook"].status, "answered");
  assert.equal(res.answers["test.hook"].probability, 0.85);
  assert.equal(res.answers["test.hook"].confidence, undefined); // No fake confidence on noul!

  assert.equal(res.answers["test.choice"].status, "answered");
  assert.equal(res.answers["test.choice"].choice, "ugc");
  assert.equal(res.answers["test.choice"].confidence, 0.92);

  assert.equal(res.answers["test.score"].status, "answered");
  assert.equal(res.answers["test.score"].score, 8.5);
  assert.equal(res.answers["test.score"].confidence, 0.88);
});

test("TypeSafeDirectJevProvider handles HTTP errors without silent coercion", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("Rate limit exceeded", { status: 429 });

  const provider = new TypeSafeDirectJevProvider({
    lookup: fixedLookup("key"),
    fetchImpl: fakeFetch,
  });

  const res = await provider.decide(sampleRequest);
  assert.equal(res.answers["test.hook"].status, "provider_error");
  assert.ok(res.answers["test.hook"].abstainReason?.includes("429"));
});

test("TypeSafeDirectJevProvider marks unreturned questions as abstain_uncertain", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          "test.hook": { noul: 0.7 },
        },
      }),
      { status: 200 }
    );

  const provider = new TypeSafeDirectJevProvider({
    lookup: fixedLookup("key"),
    fetchImpl: fakeFetch,
  });

  const res = await provider.decide(sampleRequest);
  assert.equal(res.answers["test.hook"].status, "answered");
  assert.equal(res.answers["test.choice"].status, "abstain_uncertain");
});

// The AUTO fallback is pinned for one case only: the workspace has no saved TypeSafe entry and no shared default, so TypeSafe is
// NOT_CONFIGURED and transport fallback is enabled. A saved entry that cannot be used never falls back (see the next test),
// because docs/ARCHITECTURE_CONTRACTS.md section 1.2 forbids moving a workspace's failed entry to the deployment's other key.
test("JevRouter decides only through TypeSafe: one transport, one request, and no second engine is consulted", async () => {
  const calls: string[] = [];
  const typesafe: JevProvider = {
    id: "typesafe_direct",
    capabilities: () => ({ primitives: ["noul", "choice", "score"], batchDecisions: false, explanation: false }),
    health: async () => ({ status: "READY" }),
    decide: async (request) => {
      calls.push(request.organizationId);
      return { provider: "typesafe_direct", model: "typesafe/jev-1.13", latencyMs: 1, answers: {} } as JevDecisionResponse;
    },
  };
  const router = new JevRouter({ typesafeProvider: typesafe });
  const response = await router.decide(sampleRequest);
  assert.deepEqual(calls, ["org-test"]);
  assert.equal(response.requestedProvider, "typesafe_direct");
  assert.deepEqual(Object.keys(await router.health()), ["typesafe_direct"], "the router reports one transport");
});
