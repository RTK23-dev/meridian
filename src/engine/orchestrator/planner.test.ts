import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";
import { examplePlanRaw } from "./fixtures/example-plan.ts";
import { buildPlannerPrompt, extractJsonObject, planWithModel, type ModelCall, type PlannerBrief } from "./planner.ts";

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
