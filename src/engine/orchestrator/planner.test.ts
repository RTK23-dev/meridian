import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";
import { examplePlanRaw } from "./fixtures/example-plan.ts";
import { buildPlannerPrompt, candidatesFor, extractJsonObject, planWithModel, planWithRole, type ModelCall, type PlannerBrief } from "./planner.ts";
import { deps, fixture, gatewayFor, json, ledgerWith, REQUEST_ID, RESERVATION_ID, WORKSPACE } from "../claude/test/helpers.ts";

const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const orchestrator = { provider: "openrouter" as const, id: "anthropic/claude-opus-5.5" };
const brief: PlannerBrief = {
  goal: "A 15 second product video",
  format: "a hook, a product shot, a call to action",
  userInputs: "the product is a water bottle",
  brand: { name: "Example", summary: "calm, blue, plain type" },
  budgetUsd: 2,
};

/** A call that answers with a fixed text, and records what it was asked. */
function answering(text: string, asked: { model?: string } = {}): ModelCall {
  return async ({ model }) => {
    asked.model = model.id;
    return { text };
  };
}

test("the prompt names only live candidates from the catalog, and asks for a plan", () => {
  const prompt = buildPlannerPrompt(brief, catalog);
  assert.match(prompt.system, /Reply with one JSON object/);
  assert.match(prompt.user, /black-forest-labs\/flux\.2-pro/);
  assert.match(prompt.user, /Budget \(USD\): 2/);
});

test("a plan in the reply is accepted when it validates, and the orchestrating model is the one that was called", async () => {
  const asked: { model?: string } = {};
  const outcome = await planWithModel({ orchestrator, brief, catalog, call: answering(JSON.stringify(examplePlanRaw), asked) });
  assert.equal(outcome.ok, true);
  assert.equal(asked.model, orchestrator.id);
});

test("a plan wrapped in prose is still found, and a reply with no JSON gives no plan", async () => {
  const wrapped = `Here is the plan:\n${JSON.stringify(examplePlanRaw)}\nThanks.`;
  assert.equal((await planWithModel({ orchestrator, brief, catalog, call: answering(wrapped) })).ok, true);

  const none = await planWithModel({ orchestrator, brief, catalog, call: answering("I cannot plan this.") });
  assert.deepEqual(none, { ok: false, reasons: ["the orchestrating model's reply is not a JSON plan"] });
});

test("a reply that does not match the schema gives no plan, and names the path", async () => {
  const broken = { ...(examplePlanRaw as object), version: "orchestrator-plan@9" };
  const outcome = await planWithModel({ orchestrator, brief, catalog, call: answering(JSON.stringify(broken)) });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reasons.join("\n"), /version/);
});

test("a plan that names a model outside the live catalog gives no plan, with the reason", async () => {
  const invented = structuredClone(examplePlanRaw) as { nodes: { id: string; model: unknown }[] };
  invented.nodes.find((node) => node.id === "shot_1")!.model = { provider: "openrouter", id: "vendor/invented-model" };
  const outcome = await planWithModel({ orchestrator, brief, catalog, call: answering(JSON.stringify(invented)) });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reasons.join("\n"), /vendor\/invented-model is not in the live catalog/);
});

test("a call that throws gives no plan and reports the failure, never a success", async () => {
  const outcome = await planWithModel({
    orchestrator,
    brief,
    catalog,
    call: async () => {
      throw new Error("upstream returned 503");
    },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reasons[0] ?? "", /did not answer: upstream returned 503/);
});

test("extractJsonObject returns null for text with no object, and for a broken object", () => {
  assert.equal(extractJsonObject("no braces here"), null);
  assert.equal(extractJsonObject("{ not json }"), null);
});

describe("planWithRole (the chosen model writes the plan through the Claude client)", () => {
  const haiku = { provider: "openrouter" as const, id: "anthropic/claude-haiku-5.5" };
  const scope = { requestId: REQUEST_ID, workspaceId: WORKSPACE, reservationId: RESERVATION_ID };

  test("calls the chosen model, not the route table's, and prices the reservation from its live price", async () => {
    const ledger = await ledgerWith(1);
    const { gateway, requests } = gatewayFor([json(200, fixture("openrouter-orchestrator-plan-ok"))]);
    const outcome = await planWithRole({ ...scope, deps: deps(gateway, ledger), orchestrator: haiku, brief, catalog });
    assert.equal(outcome.ok, true);
    const sent = JSON.parse(String(requests[0]?.body)) as { model: string };
    assert.equal(sent.model, "anthropic/claude-haiku-5.5", "the user's choice is the model that is called");
    if (outcome.ok) {
      assert.equal(outcome.plan.orchestrator.id, "anthropic/claude-haiku-5.5");
      assert.ok((outcome.plan.nodes.find((node) => node.id === "shot_1")?.estimateUsd ?? 0) > 0.9, "the engine's price, not the model's figure");
    }
  });

  test("refuses a plan that names another model, after one retry, and gives no plan", async () => {
    const ledger = await ledgerWith(1);
    const other = fixture("openrouter-orchestrator-plan-other-model");
    const { gateway, requests } = gatewayFor([json(200, other), json(200, other)]);
    const outcome = await planWithRole({ ...scope, deps: deps(gateway, ledger), orchestrator: haiku, brief, catalog });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reasons[0] ?? "", /did not match the plan contract/);
    assert.equal(requests.length, 2, "the call and its one retry");
  });

  test("makes no call for an orchestrator with no live per-token price, and says why", async () => {
    const ledger = await ledgerWith(1);
    const entry = catalog.get(haiku.id);
    if (entry === undefined) throw new Error("haiku must be in the recorded catalog");
    const unpriced = new Map(catalog);
    unpriced.set(haiku.id, { ...entry, pricing: { ...entry.pricing, promptUsdPerToken: null } });
    const { gateway, requests } = gatewayFor([]);
    const outcome = await planWithRole({ ...scope, deps: deps(gateway, ledger), orchestrator: haiku, brief, catalog: unpriced });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reasons[0] ?? "", /has no per-token price in the listing, so its call cannot be priced/);
    assert.equal(requests.length, 0);
  });

  test("reports a call that did not answer; it is never a plan", async () => {
    const ledger = await ledgerWith(1);
    const { gateway } = gatewayFor([]);
    const outcome = await planWithRole({ ...scope, deps: deps(gateway, ledger), orchestrator: haiku, brief, catalog });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reasons[0] ?? "", /^the orchestrating model did not answer: /);
  });

  test("caps the candidates at 40 per kind, in catalog order", () => {
    const list = candidatesFor(catalog);
    const perKind = new Map<string, number>();
    for (const candidate of list) perKind.set(candidate.kind, (perKind.get(candidate.kind) ?? 0) + 1);
    for (const [kind, count] of perKind) assert.ok(count <= 40, `${kind} has ${count}`);
    assert.ok((perKind.get("text") ?? 0) === 40);
  });
});
