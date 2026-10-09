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
  JevCapabilities,
  JevProviderHealth,
} from "./types.ts";

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
  const provider = new TypeSafeDirectJevProvider({ apiKey: "" });
  const health = await provider.health();
  assert.equal(health.status, "NOT_CONFIGURED");

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
    apiKey: "test-typesafe-key-123",
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
    apiKey: "key",
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
    apiKey: "key",
    fetchImpl: fakeFetch,
  });

  const res = await provider.decide(sampleRequest);
  assert.equal(res.answers["test.hook"].status, "answered");
  assert.equal(res.answers["test.choice"].status, "abstain_uncertain");
});

test("JevRouter routes to openrouter when typesafe_direct is unconfigured in AUTO mode", async () => {
  const mockOpenRouter: JevProvider = {
    id: "openrouter",
    capabilities(): JevCapabilities {
      return { primitives: ["noul", "choice", "score"], batchDecisions: true, explanation: false };
    },
    async health(): Promise<JevProviderHealth> {
      return { status: "READY" };
    },
    async decide(_req: JevDecisionRequest): Promise<JevDecisionResponse> {
      return {
        runId: "openrouter-run-1",
        model: "typesafe/jev-1.13",
        provider: "openrouter",
        inputHash: "hash-1",
        cached: false,
        latencyMs: 10,
        answers: {
          "test.hook": {
            questionId: "test.hook",
            questionVersion: "1.0",
            type: "noul",
            model: "typesafe/jev-1.13",
            provider: "openrouter",
            status: "answered",
            answer: true,
            noul: 0.88,
            probability: 0.88,
            evidenceRefs: [],
            evaluatedAt: new Date().toISOString(),
          },
        },
      };
    },
  };

  const router = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({ apiKey: "" }),
    openrouterProvider: mockOpenRouter,
  });

  const res = await router.decide(sampleRequest, {
    mode: "auto",
    preferredProvider: "typesafe_direct",
    fallbackEnabled: true,
  });

  assert.equal(res.provider, "openrouter");
  assert.equal(res.answers["test.hook"].status, "answered");
  assert.equal(res.answers["test.hook"].probability, 0.88);
  assert.equal(res.fallbackFrom, "typesafe_direct");
});

test("JevRouter enforces explicit mode selection without silent fallback", async () => {
  const router = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({ apiKey: "" }),
  });

  const res = await router.decide(sampleRequest, {
    mode: "typesafe_direct",
  });

  assert.equal(res.provider, "typesafe_direct");
  assert.equal(res.answers["test.hook"].status, "not_configured");
});

test("JevRouter COMPARE mode preserves both provider answers and reports agreement rate", async () => {
  const mockDirect: JevProvider = {
    id: "typesafe_direct",
    capabilities: () => ({ primitives: ["noul", "choice", "score"], batchDecisions: true, explanation: false }),
    health: async () => ({ status: "READY" }),
    decide: async () => ({
      runId: "run-direct",
      model: "typesafe/jev-1.13",
      provider: "typesafe_direct",
      inputHash: "h1",
      cached: false,
      latencyMs: 15,
      answers: {
        "test.hook": {
          questionId: "test.hook",
          questionVersion: "1.0",
          model: "typesafe/jev-1.13",
          provider: "typesafe_direct",
          status: "answered",
          answer: 0.8,
          noul: 0.8,
          evidenceRefs: [],
          evaluatedAt: new Date().toISOString(),
        },
      },
    }),
  };

  const mockOpenRouter: JevProvider = {
    id: "openrouter",
    capabilities: () => ({ primitives: ["noul", "choice", "score"], batchDecisions: true, explanation: false }),
    health: async () => ({ status: "READY" }),
    decide: async () => ({
      runId: "run-openrouter",
      model: "typesafe/jev-1.13",
      provider: "openrouter",
      inputHash: "h2",
      cached: false,
      latencyMs: 25,
      answers: {
        "test.hook": {
          questionId: "test.hook",
          questionVersion: "1.0",
          model: "typesafe/jev-1.13",
          provider: "openrouter",
          status: "answered",
          answer: 0.8,
          noul: 0.8,
          evidenceRefs: [],
          evaluatedAt: new Date().toISOString(),
        },
      },
    }),
  };

  const router = new JevRouter({
    typesafeProvider: mockDirect,
    openrouterProvider: mockOpenRouter,
  });

  const res = await router.decide(sampleRequest, {
    mode: "compare",
    preferredProvider: "typesafe_direct",
  });

  assert.equal(res.provider, "typesafe_direct");
  assert.ok(res.comparison);
  assert.equal(res.comparison.comparedWith, "openrouter");
  assert.equal(res.comparison.agreementRate, 1.0);
  assert.equal(res.comparison.comparedResponse.provider, "openrouter");
});
