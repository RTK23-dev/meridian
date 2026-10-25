// JEV's image path through the real shared gate and dispatcher. The workspace's JEV backend and OpenRouter model are stored in the
// test database, and the gate reads them the same way production does. Only the OpenRouter HTTP call and the TypeSafe router are
// fakes, so each case shows which request bodies would have reached a provider. No request reaches a network.

import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import type { JevProviderRouter, JevQuestionSpec } from "../jev/types.ts";
import { recordedDecisionCatalogSource } from "../testing/decision-catalog-fixture.ts";
import { PNG, studioTenant } from "../testing/durable-image-fixtures.ts";
import { IMAGE_SCOPE, runEngineGate, type GateEvidenceInput, type GateQuestion, type GateResult } from "./gate.ts";
import { JevDecisionEngine } from "./jev-engine.ts";
import { OpenRouterDecisionsEngine, type OpenRouterCheckStore, OPENROUTER_DECISIONS_EXAMPLE_MODEL } from "./openrouter-engine.ts";
import type { DecisionEngine, DecisionEngineId, DecisionRequest, DecisionResult } from "./types.ts";
import { memoryDecisionHolds } from "./holds.ts";

const KEY = "sk-or-v1-jev-image-fixture-secret-0123456789";

const CLAIM: JevQuestionSpec = {
  id: "test.jev_image.claim.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the copy free of unsubstantiated claims?",
  criteria: { true: "No unsubstantiated claim.", false: "Contains an unsubstantiated claim." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.95, reviewMinProbability: 0.8 },
};
const PRODUCT: JevQuestionSpec = {
  id: "test.jev_image.product.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the product visible in the image?",
  criteria: { true: "Visible.", false: "Not visible." },
  evidenceRequirements: ["image"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};

const COPY: GateEvidenceInput = { kind: "text", name: "copy", source: "test", content: { copy: "A plain product description." } };
const FRAME: GateEvidenceInput = { kind: "image", name: "frame-0", sha256: "f".repeat(64), source: "test" };
const QUESTIONS: GateQuestion[] = [
  { key: "claim", spec: CLAIM, needsImage: false, evidenceScope: ["copy"] },
  { key: "product", spec: PRODUCT, needsImage: true, evidenceScope: [IMAGE_SCOPE] },
];

type Wire = { model: string; state: unknown; questions: Record<string, unknown> };
type Recorded = { url: string; body: Wire };

/** An OpenRouter engine whose HTTP call is a fixture. It answers every question it is asked, and records each request body. */
function openRouterWith(): { engine: OpenRouterDecisionsEngine; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Wire;
    requests.push({ url: String(url), body });
    const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.97 }]));
    return new Response(
      JSON.stringify({ model: "typesafe/jev-1.14-20261014", provider: "TypeSafe", id: "gen-jev-image-1", answers, usage: { input_tokens: 120, output_tokens: 0, cost: 0.0000051 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const keys = { async keyFor() { return { secret: KEY, fingerprint: "sk-or-…6789", reason: "" }; } };
  const store: OpenRouterCheckStore = { async workspaceModel() { return OPENROUTER_DECISIONS_EXAMPLE_MODEL; }, async latestCheck() { return null; } };
  const engine = new OpenRouterDecisionsEngine({ holds: memoryDecisionHolds(), fetchImpl, keys, store, deploymentModel: undefined, catalog: recordedDecisionCatalogSource() });
  return { engine, requests };
}

/** The TypeSafe router, as JEV sees it. It records what it was given, so a test can show whether images reached it. */
function typesafeRouter(): { router: JevProviderRouter; requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  const router = {
    getProvider: () => ({ id: "typesafe_direct", capabilities: () => ({}), health: async () => ({ status: "READY" }), healthFor: async () => ({ status: "READY" }), decide: async () => ({}) }),
    health: async () => ({}),
    decide: async (request: DecisionRequest) => {
      requests.push(request);
      return { runId: "run_typesafe_fixture", model: "typesafe/jev-1.14", provider: "typesafe_direct", inputHash: "h", cached: false, latencyMs: 1, answers: {} };
    },
  } as unknown as JevProviderRouter;
  return { router, requests };
}

/** An engine that must never be called in a case. Calling it fails the test, because it would mean the wrong backend answered. */
function neverCalled(id: DecisionEngineId): DecisionEngine {
  const refuse = async (): Promise<DecisionResult> => {
    throw new Error(`The ${id} engine was called, which this case does not allow.`);
  };
  return {
    id,
    adapterVersion: "never-called",
    capabilities: () => ({ engineId: id, questionKinds: [], inputModalities: ["text"], maxImages: 0, maxImageBytes: 0, imageMimeTypes: [], batchQuestions: false, reportsUsage: false, semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" } }),
    health: async () => ({ status: "NOT_CONFIGURED", message: "not used" }),
    decide: refuse,
  } as unknown as DecisionEngine;
}

async function chooseJevBackend(sql: Sql, organizationId: string, backend: "typesafe_direct" | "openrouter", model?: string): Promise<void> {
  await sql`
    insert into decision_engine_jev_config (organization_id, backend, updated_by) values (${organizationId}, ${backend}, 'test')
    on conflict (organization_id) do update set backend = excluded.backend
  `;
  if (model) {
    await sql`
      insert into decision_engine_openrouter_config (organization_id, model, updated_by) values (${organizationId}, ${model}, 'test')
      on conflict (organization_id) do update set model = excluded.model
    `;
  }
}

async function runGate(input: { sql: Sql; organizationId: string; brandId: string; engines: Record<DecisionEngineId, DecisionEngine>; withImage: boolean }): Promise<GateResult> {
  return runEngineGate({
    sql: input.sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "jev_image_regression",
    subject: { type: "creative", id: `creative-${globalThis.crypto.randomUUID()}` },
    description: "A creative whose product must be visible.",
    questions: QUESTIONS,
    evidence: input.withImage ? [COPY, FRAME] : [COPY],
    images: input.withImage ? [{ bytes: PNG, label: "Frame at 3.2s", evidenceRef: { field: "scene", location: { startMs: 3200 } }, evidenceName: "frame-0" }] : [],
    engines: input.engines,
    selection: { engineId: "jev", source: "workspace" },
  });
}

test("JEV through OpenRouter with jev-1.14: the image reaches the OpenRouter request through the real gate and dispatcher, in its own scope", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "jev-or-image");
  await chooseJevBackend(sql, tenant.organizationId, "openrouter", "typesafe/jev-1.14");
  const openrouter = openRouterWith();
  const typesafe = typesafeRouter();
  const engines = {
    jev: new JevDecisionEngine(typesafe.router, { openrouter: openrouter.engine }),
    "openai-decisions": neverCalled("openai-decisions"),
    "openrouter-decisions": openrouter.engine,
  };

  const result = await runGate({ sql, organizationId: tenant.organizationId, brandId: tenant.brandId, engines, withImage: true });

  assert.equal(typesafe.requests.length, 0, "the TypeSafe router is not called when JEV's backend is OpenRouter");
  assert.equal(openrouter.requests.length, 2, "one OpenRouter call for the copy scope and one for the image scope");
  const imageCall = openrouter.requests.find((request) => Array.isArray(request.body.state));
  const copyCall = openrouter.requests.find((request) => !Array.isArray(request.body.state));
  assert.ok(imageCall, "the image scope's request carries the image");
  assert.ok(copyCall, "the copy scope's request carries text only");
  assert.deepEqual(Object.keys(imageCall.body.questions), ["product"], "the image call asks only the image question");
  assert.deepEqual(Object.keys(copyCall.body.questions), ["claim"], "the copy call asks only the copy question");
  const imagePart = (imageCall.body.state as Array<{ type?: string; image_url?: { url?: string } }>).find((part) => part.type === "image_url");
  assert.match(imagePart?.image_url?.url ?? "", /^data:image\/png;base64,/, "the image is sent as a PNG data URL");
  assert.equal(result.imagesSent, 1);
  assert.equal(result.imagesOmitted, 0);
  assert.equal(result.answers.product?.status, "answered", "the image question is answered by the model that saw the image");
  assert.equal(result.answers.claim?.status, "answered");
});

test("JEV through OpenRouter with jev-1.13, which the profile keeps text-only: no image reaches OpenRouter, and the visual question goes to review", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "jev-or-text-model");
  await chooseJevBackend(sql, tenant.organizationId, "openrouter", "typesafe/jev-1.13");
  const openrouter = openRouterWith();
  const typesafe = typesafeRouter();
  const engines = {
    jev: new JevDecisionEngine(typesafe.router, { openrouter: openrouter.engine }),
    "openai-decisions": neverCalled("openai-decisions"),
    "openrouter-decisions": openrouter.engine,
  };

  const result = await runGate({ sql, organizationId: tenant.organizationId, brandId: tenant.brandId, engines, withImage: true });

  const sentImage = openrouter.requests.some((request) => JSON.stringify(request.body).includes("image_url"));
  assert.equal(sentImage, false, "a model without a verified image profile never receives image bytes");
  assert.equal(result.imagesSent, 0);
  assert.equal(result.imagesOmitted, 1, "the image is recorded as omitted, not silently dropped");
  assert.notEqual(result.answers.product?.status, "answered", "a visual judgement without its image is not an answer");
  assert.equal(result.answers.claim?.status, "answered", "the text question is still answered");
});

test("JEV through TypeSafe: image evidence is never sent, the TypeSafe router gets text only, and OpenRouter is not called", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "jev-typesafe-image");
  await chooseJevBackend(sql, tenant.organizationId, "typesafe_direct");
  const openrouter = openRouterWith();
  const typesafe = typesafeRouter();
  const engines = {
    jev: new JevDecisionEngine(typesafe.router, { openrouter: openrouter.engine }),
    "openai-decisions": neverCalled("openai-decisions"),
    "openrouter-decisions": neverCalled("openrouter-decisions"),
  };

  const result = await runGate({ sql, organizationId: tenant.organizationId, brandId: tenant.brandId, engines, withImage: true });

  assert.equal(openrouter.requests.length, 0, "OpenRouter is not called for a TypeSafe backend");
  for (const request of typesafe.requests) {
    assert.equal("images" in request, false, "the TypeSafe request carries no image field");
    assert.equal(request.images, undefined);
  }
  assert.equal(result.imagesSent, 0);
  assert.notEqual(result.answers.product?.status, "answered", "JEV through TypeSafe does not judge the image");
});
