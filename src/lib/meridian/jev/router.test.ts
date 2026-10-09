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
