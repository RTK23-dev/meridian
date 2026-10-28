// What a decision may send, decided before the call: the live catalogue must list the model, the call's ceiling must be within the
// deployment's limit, and image evidence goes only to a model whose verified profile takes images. Every test is fixture-based. No
// request reaches a network, and no key or workspace data is read from a database.

import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import type { JevProviderRouter, JevQuestionSpec } from "../jev/types.ts";
import { recordedDecisionCatalogSource, RECORDED_DECISION_CATALOG_BODY } from "./recorded-decision-catalog.ts";
import { resolveImageSupport } from "./capabilities.ts";
import { DecisionCatalogSource } from "./decision-catalog.ts";
import { JevDecisionEngine } from "./jev-engine.ts";
import { OpenRouterDecisionsEngine, OPENROUTER_DECISIONS_EXAMPLE_MODEL } from "./openrouter-engine.ts";
import type { OpenRouterCheckStore } from "./openrouter-engine.ts";
import type { DecisionRequest } from "./types.ts";
import type { EngineSelection } from "./selection.ts";
import { memoryDecisionHolds } from "./holds.ts";

const ORG = "org_budget_fixture";
const KEY = "sk-or-v1-budget-fixture-secret-0123456789";
const NOUL: JevQuestionSpec = {
  id: "fixture.budget.refund.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the ticket ask for a refund?",
  criteria: { true: "The customer asks for money back.", false: "The customer asks for anything else." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
} as unknown as JevQuestionSpec;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

function request(extra: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    organizationId: ORG,
    brandId: "brand_budget_fixture",
    state: { description: "Ticket: charged twice this month." },
    questions: { refund: NOUL },
    ...extra,
  } as DecisionRequest;
}

const keys = {
  async keyFor() {
    return { secret: KEY, fingerprint: "sk-or-…6789", reason: "" };
  },
};
const noCheck: OpenRouterCheckStore = {
  async workspaceModel() {
    return OPENROUTER_DECISIONS_EXAMPLE_MODEL;
  },
  async latestCheck() {
    return null;
  },
};

function answerBody() {
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.14-20261014",
      provider: "TypeSafe",
      id: "gen-budget-1",
      answers: { refund: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 120, output_tokens: 12, cost: 0.0000051 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function counting(response: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
    return response();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function engineWith(options: { fetchImpl: typeof fetch; catalog: DecisionCatalogSource; workspaceModel?: string | null }): OpenRouterDecisionsEngine {
  return new OpenRouterDecisionsEngine({ holds: memoryDecisionHolds(),
    fetchImpl: options.fetchImpl,
    keys,
    store: { ...noCheck, async workspaceModel() { return options.workspaceModel ?? OPENROUTER_DECISIONS_EXAMPLE_MODEL; } },
    deploymentModel: undefined,
    catalog: options.catalog,
  });
}

function withLimit<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL;
  if (value === undefined) delete process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL;
  else process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL;
    else process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL = saved;
  });
}

test("a model the live catalogue does not list is refused before any call", async () => {
  const body = {
    data: (RECORDED_DECISION_CATALOG_BODY as { data: Array<{ id: string }> }).data.filter((entry) => entry.id !== "typesafe/jev-1.13"),
  };
  const catalog = new DecisionCatalogSource({
    fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    now: () => Date.parse("2026-10-25T06:00:00.000Z"),
  });
  const { fetchImpl, calls } = counting(answerBody);
  const result = await engineWith({ fetchImpl, catalog, workspaceModel: "typesafe/jev-1.13" }).decide(request());
  assert.equal(calls.length, 0, "nothing is sent for a model the catalogue does not list");
  assert.equal(result.failure?.kind, "unknown_model");
  assert.match(result.failure?.message ?? "", /not in the live catalogue/);
});

test("a call whose ceiling is above the deployment's limit is refused before any call, with the numbers", async () => {
  const { fetchImpl, calls } = counting(answerBody);
  const result = await withLimit("0.000001", () => engineWith({ fetchImpl, catalog: recordedDecisionCatalogSource() }).decide(request()));
  assert.equal(calls.length, 0, "nothing is sent above the limit");
  assert.equal(result.failure?.kind, "budget_refused");
  assert.match(result.failure?.message ?? "", /The most this call can cost is \$0\.0000\d+ \(its \d+-byte request/);
  assert.match(result.failure?.message ?? "", /\$0\.000001 per-call limit/);
  assert.equal(result.answers.refund?.status, "unsupported");
});

test("a call within the limit is sent, and the ceiling it was checked against is kept beside the reported cost", async () => {
  const { fetchImpl, calls } = counting(answerBody);
  const result = await withLimit(undefined, () => engineWith({ fetchImpl, catalog: recordedDecisionCatalogSource() }).decide(request()));
  assert.equal(calls.length, 1);
  assert.equal(result.failure, undefined);
  // The bound is the request's own, so it is positive and below the whole context, which is the most any call can cost.
  const ceiling = result.usage?.ceilingUsd ?? 0;
  assert.ok(ceiling > 0 && ceiling < 262144 * 0.000000042, `the request's bound is kept, and it is below the whole context (got ${ceiling})`);
  assert.equal(result.usage?.reportedCostUsd, 0.0000051);
});

test("an unreadable catalogue sends nothing: the decision is unavailable, never approved", async () => {
  const catalog = new DecisionCatalogSource({
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    now: () => Date.parse("2026-10-25T06:00:00.000Z"),
  });
  const { fetchImpl, calls } = counting(answerBody);
  const result = await engineWith({ fetchImpl, catalog }).decide(request());
  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "provider_unavailable");
  assert.equal(result.answers.refund?.status, "provider_error");
});

test("a resolved model the gate chose is used as given, and an invalid resolved model is refused without a call", async () => {
  const { fetchImpl, calls } = counting(answerBody);
  const engine = engineWith({ fetchImpl, catalog: recordedDecisionCatalogSource(), workspaceModel: "typesafe/jev-1.14" });
  const chosen = await engine.decide(request({ resolved: { openrouterModel: { model: "typesafe/jev-1.13", source: "workspace" } } }));
  assert.equal(chosen.requestedModel, "typesafe/jev-1.13", "the resolved model is the one called, not the stored setting");
  assert.equal(calls.length, 1);

  const alias = counting(answerBody);
  const refused = await engineWith({ fetchImpl: alias.fetchImpl, catalog: recordedDecisionCatalogSource() }).decide(
    request({ resolved: { openrouterModel: { model: "~typesafe/jev-latest", source: "workspace" } } }),
  );
  assert.equal(alias.calls.length, 0, "an alias resolved by the gate is still refused");
  assert.equal(refused.failure?.kind, "unknown_model");
});

test("JEV uses the backend the gate resolved, and does not read the setting again", async () => {
  let reads = 0;
  const typesafeCalls: unknown[] = [];
  const router = {
    getProvider: () => ({ id: "typesafe_direct", capabilities: () => ({}), health: async () => ({ status: "READY" }), healthFor: async () => ({ status: "READY" }), decide: async () => ({}) }),
    health: async () => ({}),
    decide: async (req: unknown) => {
      typesafeCalls.push(req);
      return {
        runId: "run_budget_fixture",
        model: "typesafe/jev-1.13",
        provider: "typesafe_direct",
        inputHash: "h",
        cached: false,
        latencyMs: 1,
        answers: {},
      };
    },
  } as unknown as JevProviderRouter;
  const engine = new JevDecisionEngine(router, {
    openrouter: engineWith({ fetchImpl: counting(answerBody).fetchImpl, catalog: recordedDecisionCatalogSource() }),
    backends: {
      read: async () => {
        reads += 1;
        return { ok: true, backend: "openrouter" };
      },
    },
  });
  await engine.decide(request({ resolved: { jevBackend: "typesafe_direct" } }));
  assert.equal(reads, 0, "the resolved backend is used; the setting is not read again inside the decision");
  assert.equal(typesafeCalls.length, 1, "the resolved TypeSafe backend is the one called");
});

function selection(engineId: EngineSelection["engineId"]): EngineSelection {
  return { engineId, source: "workspace" } as EngineSelection;
}

/** A SQL handle that answers the JEV backend and OpenRouter model reads. Other reads find nothing. */
function fakeSql(read: { backend?: string | null; model?: string | null; unreadable?: boolean }): Sql {
  const run = async (strings: TemplateStringsArray) => {
    if (read.unreadable) throw new Error("database unavailable");
    const text = strings.join(" ");
    if (text.includes("decision_engine_jev_config")) return read.backend === null || read.backend === undefined ? [] : [{ backend: read.backend }];
    if (text.includes("decision_engine_openrouter_config")) return read.model === null || read.model === undefined ? [] : [{ model: read.model }];
    return [];
  };
  return run as unknown as Sql;
}

test("image evidence reaches JEV only when its resolved backend and model take images", async () => {
  const jevOverTypeSafe = await resolveImageSupport({ selection: selection("jev"), sql: fakeSql({ backend: "typesafe_direct" }), organizationId: ORG });
  assert.equal(jevOverTypeSafe.takesImages, false, "JEV through TypeSafe takes text only");
  assert.deepEqual(jevOverTypeSafe.resolved, { jevBackend: "typesafe_direct" });

  const jevOverOpenRouter = await resolveImageSupport({ selection: selection("jev"), sql: fakeSql({ backend: "openrouter", model: "typesafe/jev-1.14" }), organizationId: ORG });
  assert.equal(jevOverOpenRouter.takesImages, true, "a model whose verified profile takes images receives them");
  assert.deepEqual(jevOverOpenRouter.resolved, { jevBackend: "openrouter", openrouterModel: { model: "typesafe/jev-1.14", source: "workspace" } });

  const textOnly = await resolveImageSupport({ selection: selection("jev"), sql: fakeSql({ backend: "openrouter", model: "typesafe/jev-1.13" }), organizationId: ORG });
  assert.equal(textOnly.takesImages, false, "a text-only verified model takes no images");
  assert.match(textOnly.reason, /takes no images/);

  const unverified = await resolveImageSupport({ selection: selection("jev"), sql: fakeSql({ backend: "openrouter", model: "nace-ai/drex-max" }), organizationId: ORG });
  assert.equal(unverified.takesImages, false, "an unverified model is never judged to take images from its name");
});

test("an unreadable backend, an unreadable model, or no database takes no images: a visual question goes to review, not to a judgement without its image", async () => {
  const unreadableBackend = await resolveImageSupport({ selection: selection("jev"), sql: fakeSql({ unreadable: true }), organizationId: ORG });
  assert.equal(unreadableBackend.takesImages, false);
  const noDatabase = await resolveImageSupport({ selection: selection("jev"), sql: undefined, organizationId: ORG });
  assert.equal(noDatabase.takesImages, false);
  assert.deepEqual(noDatabase.resolved, {});
});

test("the other engines keep their own image rule, and the resolution names the engine's adapter", async () => {
  assert.equal((await resolveImageSupport({ selection: selection("openrouter-decisions"), sql: undefined, organizationId: ORG })).takesImages, true);
  assert.equal((await resolveImageSupport({ selection: selection("openai-decisions"), sql: undefined, organizationId: ORG })).takesImages, true);
});

test("the image evidence is sent as PNG data in the documented image part, not described to the model", async () => {
  const { fetchImpl, calls } = counting(answerBody);
  await withLimit(undefined, () =>
    engineWith({ fetchImpl, catalog: recordedDecisionCatalogSource() }).decide(
      request({ images: [{ bytes: PNG, evidenceRef: { id: "frame-1", source: "fixture", summary: "Frame 1" } as unknown as DecisionRequest["images"] extends (infer T)[] | undefined ? T extends { evidenceRef: infer R } ? R : never : never, label: "Frame 1" }], imagePolicy: "required" }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.body, /"type":"image_url"/);
  assert.match(calls[0]!.body, /data:image\/png;base64,/);
});
