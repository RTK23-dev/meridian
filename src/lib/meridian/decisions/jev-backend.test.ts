// JEV's backend choice on fixtures. A fake TypeSafe router and a fake OpenRouter fetch stand in for the two services, and the
// backend store is injected, so no test reaches a network or a database. The tests check that the chosen backend is the only
// one called, that nothing falls back to another backend, that an unreadable or unknown setting makes no call, and that
// readiness is reported for the backend that is asked about.

import assert from "node:assert/strict";
import test from "node:test";
import type { JevDecisionResponse, JevProvider, JevProviderRouter, JevQuestionSpec } from "../jev/types.ts";
import { JevDecisionEngine } from "./jev-engine.ts";
import { isJevBackend, DEFAULT_JEV_BACKEND, type JevBackendStore } from "./jev-backend.ts";
import { OpenRouterDecisionsEngine, OPENROUTER_DECISIONS_DEFAULT_MODEL } from "./openrouter-engine.ts";
import type { OpenRouterCheckRecord } from "./openrouter-settings.ts";
import { getDecisionEngineStatus } from "./status.ts";
import type { DecisionEngineRegistry } from "./dispatcher.ts";
import type { Sql } from "../learning/store.ts";
import type { DecisionEngine, DecisionRequest } from "./types.ts";
import { recordedDecisionCatalogSource } from "../testing/decision-catalog-fixture.ts";
import { memoryDecisionHolds } from "./holds.ts";

const ORG = "org_jev_backend_fixture";
const KEY = "sk-or-v1-jev-backend-secret-abcdef0123456789";

const NOUL: JevQuestionSpec = {
  id: "fixture.jev.refund.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the ticket ask for a refund?",
  criteria: { true: "The customer asks for money back.", false: "The customer asks for anything else." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
} as unknown as JevQuestionSpec;

function request(): DecisionRequest {
  return {
    organizationId: ORG,
    brandId: "brand_jev_backend_fixture",
    state: { description: "Ticket: charged twice this month." },
    questions: { refund: NOUL },
  } as DecisionRequest;
}

/** A TypeSafe router that records each call and answers the question. */
function typesafeRouter(calls: unknown[], options: { healthy?: boolean } = {}): JevProviderRouter {
  const healthy = options.healthy ?? true;
  const provider = {
    id: "typesafe_direct",
    capabilities: () => ({ primitives: ["noul", "choice", "score"], batchDecisions: true, explanation: false }),
    health: async () => (healthy ? { status: "READY" } : { status: "NOT_CONFIGURED", message: "No TypeSafe key is saved." }),
    healthFor: async () => (healthy ? { status: "READY" } : { status: "NOT_CONFIGURED", message: "No TypeSafe key is saved." }),
    decide: async () => {
      throw new Error("the provider's decide is not used by the router stub");
    },
  } as unknown as JevProvider;
  return {
    getProvider: () => provider,
    health: async () => ({ typesafe_direct: { status: "READY" } }),
    decide: async (req: unknown): Promise<JevDecisionResponse> => {
      calls.push(req);
      return {
        runId: "run_typesafe_fixture",
        model: "typesafe/jev-1.13",
        provider: "typesafe_direct",
        inputHash: "hash_typesafe",
        cached: false,
        latencyMs: 1,
        answers: {
          refund: {
            questionId: NOUL.id,
            questionVersion: NOUL.version,
            type: "noul",
            model: "typesafe/jev-1.13",
            provider: "typesafe_direct",
            status: "answered",
            evidenceRefs: [],
            evaluatedAt: new Date().toISOString(),
            noul: 0.7,
            probability: 0.7,
            answer: 0.7,
            semantics: "probability",
            calibrationStatus: "uncalibrated",
          },
        },
      } as unknown as JevDecisionResponse;
    },
  } as unknown as JevProviderRouter;
}

/**
 * An OpenRouter Decisions engine whose key is a fixture key, and whose fetch is the given stub. `check` is the connection test
 * the workspace has on record; none means no test has been run.
 */
function openrouter(
  fetchImpl: typeof fetch,
  calls: string[] = [],
  check: OpenRouterCheckRecord | null = null,
): OpenRouterDecisionsEngine {
  return new OpenRouterDecisionsEngine({ holds: memoryDecisionHolds(),
    catalog: recordedDecisionCatalogSource(),
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      return fetchImpl(url, init);
    }) as typeof fetch,
    keys: {
      async keyFor() {
        return { secret: KEY, fingerprint: "sk-or-…6789", reason: "" };
      },
    },
    store: {
      async workspaceModel() {
        return null;
      },
      async latestCheck() {
        return check;
      },
    },
    deploymentModel: undefined,
  });
}

function storeReturning(read: Awaited<ReturnType<JevBackendStore["read"]>>): JevBackendStore {
  return { read: async () => read };
}

/** A passed connection test for the fixture key and the default OpenRouter model. */
const PASSED_CHECK: OpenRouterCheckRecord = {
  status: "passed",
  model: OPENROUTER_DECISIONS_DEFAULT_MODEL,
  keyFingerprint: "sk-or-…6789",
  message: "ok",
  checkedAt: "2026-10-20T10:00:00.000Z",
  returnedModel: "typesafe/jev-1.14-20261014",
  upstreamProvider: "TypeSafe",
  providerRequestId: "gen-check-fixture",
};

/** A SQL handle that answers only the JEV backend query, with the given row or none. Other reads find nothing. */
function fakeSql(jevRow: { backend: string } | null): Sql {
  const run = async (strings: TemplateStringsArray) => {
    if (strings.join(" ").includes("decision_engine_jev_config")) return jevRow ? [jevRow] : [];
    return [];
  };
  return run as unknown as Sql;
}

/** An engine that is not selected in the status test. A call to it fails the test. */
function idleEngine(id: "openai-decisions"): DecisionEngine {
  return {
    id,
    adapterVersion: "idle-engine.v1",
    capabilities: () => ({ engineId: id }) as unknown as ReturnType<DecisionEngine["capabilities"]>,
    health: async () => ({ status: "NOT_CONFIGURED", message: "Not selected in this test." }),
    decide: async () => {
      throw new Error("This engine was called, but the test does not select it.");
    },
  };
}

function openrouterAnswer(): Response {
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.14-20261014",
      provider: "TypeSafe",
      id: "gen-dec-jev-backend-1",
      answers: { refund: { type: "noul", noul: 0.91 } },
      usage: { input_tokens: 120, output_tokens: 12, cost: 0.0000051 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("with no stored backend, JEV uses TypeSafe, the documented default, and OpenRouter is not called", async () => {
  const typesafeCalls: unknown[] = [];
  const openrouterCalls: string[] = [];
  const engine = new JevDecisionEngine(typesafeRouter(typesafeCalls), {
    openrouter: openrouter(async () => openrouterAnswer(), openrouterCalls),
    backends: storeReturning({ ok: true, backend: null }),
  });
  const result = await engine.decide(request());
  assert.equal(DEFAULT_JEV_BACKEND, "typesafe_direct");
  assert.equal(typesafeCalls.length, 1);
  assert.equal(openrouterCalls.length, 0);
  assert.equal(result.engineId, "jev");
  assert.equal(result.provider, "typesafe_direct");
});

test("a workspace that chose OpenRouter gets its JEV decisions from OpenRouter, with its model, and TypeSafe is never called", async () => {
  const typesafeCalls: unknown[] = [];
  const openrouterCalls: string[] = [];
  const engine = new JevDecisionEngine(typesafeRouter(typesafeCalls), {
    openrouter: openrouter(async () => openrouterAnswer(), openrouterCalls),
    backends: storeReturning({ ok: true, backend: "openrouter" }),
  });
  const result = await engine.decide(request());
  assert.equal(typesafeCalls.length, 0, "no TypeSafe call");
  assert.equal(openrouterCalls.length, 1, "one OpenRouter call");
  assert.equal(result.engineId, "jev", "the decision is recorded as a JEV decision");
  assert.equal(result.provider, "openrouter", "OpenRouter is the provider that served it");
  assert.equal(result.requestedModel, OPENROUTER_DECISIONS_DEFAULT_MODEL, "the workspace's OpenRouter model, not a hard-coded one");
  assert.equal(result.returnedModel, "typesafe/jev-1.14-20261014", "the model OpenRouter reports is kept");
  assert.equal(result.usage?.reportedCostUsd, 0.0000051);
  assert.equal((result.answers.refund as { status: string }).status, "answered");
  assert.equal(JSON.stringify(result).includes(KEY), false, "the key is in no result");
});

test("an OpenRouter failure is reported as that failure: TypeSafe is not tried in its place", async () => {
  const typesafeCalls: unknown[] = [];
  const engine = new JevDecisionEngine(typesafeRouter(typesafeCalls), {
    openrouter: openrouter(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
    backends: storeReturning({ ok: true, backend: "openrouter" }),
  });
  const result = await engine.decide(request());
  assert.equal(typesafeCalls.length, 0, "no fallback to TypeSafe");
  assert.equal(result.failure?.kind, "rate_limited");
  assert.equal((result.answers.refund as { status: string }).status, "provider_error");
});

test("an unreadable JEV backend setting makes no request to any service, and says why", async () => {
  const typesafeCalls: unknown[] = [];
  const openrouterCalls: string[] = [];
  const engine = new JevDecisionEngine(typesafeRouter(typesafeCalls), {
    openrouter: openrouter(async () => openrouterAnswer(), openrouterCalls),
    backends: storeReturning({ ok: false, reason: "The JEV backend setting could not be read, so JEV made no request." }),
  });
  const result = await engine.decide(request());
  assert.equal(typesafeCalls.length, 0);
  assert.equal(openrouterCalls.length, 0);
  assert.equal(result.failure?.kind, "not_configured");
  assert.match(result.failure?.message ?? "", /could not be read/);
});

test("a stored value that is not a known backend is refused, not guessed at", async () => {
  assert.equal(isJevBackend("typesafe_direct"), true);
  assert.equal(isJevBackend("openrouter"), true);
  assert.equal(isJevBackend("openai-decisions"), false, "OpenAI is not a JEV backend");
  assert.equal(isJevBackend("typesafe"), false, "an unknown spelling is not a backend");
  assert.equal(isJevBackend(undefined), false);
});

test("readiness is reported for the backend asked about, and an unreadable setting is UNAVAILABLE", async () => {
  const typesafeCalls: unknown[] = [];
  const engine = new JevDecisionEngine(typesafeRouter(typesafeCalls, { healthy: false }), {
    openrouter: openrouter(async () => openrouterAnswer()),
    backends: storeReturning({ ok: true, backend: "openrouter" }),
  });
  const forTypeSafe = await engine.healthForBackend(ORG, "typesafe_direct");
  assert.equal(forTypeSafe.status, "NOT_CONFIGURED", "TypeSafe is not ready, whatever the stored choice is");
  const forOpenRouter = await engine.healthFor(ORG);
  assert.match(forOpenRouter.message ?? "", /^JEV via OpenRouter\./, "the stored choice, OpenRouter, is the one reported");
  assert.equal(forOpenRouter.status, "CONFIGURED", "a key and model with no passed connection test are not ready");

  const ready = new JevDecisionEngine(typesafeRouter([]), {
    openrouter: openrouter(async () => openrouterAnswer(), [], PASSED_CHECK),
    backends: storeReturning({ ok: true, backend: "openrouter" }),
  });
  assert.equal((await ready.healthFor(ORG)).status, "READY", "a passed test for this key and model makes it ready");

  const unreadable = new JevDecisionEngine(typesafeRouter([]), {
    openrouter: openrouter(async () => openrouterAnswer()),
    backends: storeReturning({ ok: false, reason: "unreadable" }),
  });
  assert.equal((await unreadable.healthFor(ORG)).status, "UNAVAILABLE");
});

test("the status payload names the stored JEV backend and each backend's readiness for the workspace", async () => {
  const engines: DecisionEngineRegistry = {
    jev: new JevDecisionEngine(typesafeRouter([], { healthy: false }), {
      openrouter: openrouter(async () => openrouterAnswer(), [], PASSED_CHECK),
      backends: storeReturning({ ok: true, backend: "openrouter" }),
    }),
    "openai-decisions": idleEngine("openai-decisions"),
    "openrouter-decisions": openrouter(async () => openrouterAnswer(), [], PASSED_CHECK),
  };
  const status = await getDecisionEngineStatus(fakeSql({ backend: "openrouter" }), ORG, engines);
  assert.deepEqual(status.jevBackend, { backend: "openrouter", source: "workspace" });
  const readiness = Object.fromEntries(status.jevBackends.map((option) => [option.backend, option.health.status]));
  assert.deepEqual(readiness, { typesafe_direct: "NOT_CONFIGURED", openrouter: "READY" });

  const unsaved = await getDecisionEngineStatus(fakeSql(null), ORG, engines);
  assert.deepEqual(unsaved.jevBackend, { backend: "typesafe_direct", source: "default" }, "no row means the documented default");

  const withoutDatabase = await getDecisionEngineStatus(undefined, ORG, engines);
  assert.equal(withoutDatabase.jevBackend.backend, null, "without a database the stored choice is unknown, not assumed");
  assert.match(withoutDatabase.jevBackend.reason ?? "", /without a database/);
});

test("the TypeSafe path keeps its documented shape: text only, and a required image is refused without a call", async () => {
  const typesafeCalls: unknown[] = [];
  const engine = new JevDecisionEngine(typesafeRouter(typesafeCalls), {
    openrouter: openrouter(async () => openrouterAnswer()),
    backends: storeReturning({ ok: true, backend: null }),
  });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = await engine.decide({ ...request(), images: [{ bytes: png }], imagePolicy: "required" });
  assert.equal(typesafeCalls.length, 0, "JEV over TypeSafe does not take images");
  assert.equal(result.failure?.kind, "unsupported_input");
});
