import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";
import { orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import { topologicalOrder, validatePlan } from "./validate.ts";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8"));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

/** A copy of the sample plan, changed by `edit`, parsed the way a model's output is parsed. */
function planWith(edit: (plan: Record<string, any>) => void): OrchestratorPlan {
  const copy = structuredClone(sample);
  edit(copy);
  return orchestratorPlanSchema.parse(copy);
}

const step = (plan: Record<string, any>, id: string) => plan.nodes.find((node: { id: string }) => node.id === id);

test("the sample plan validates, and its order puts every step after the steps it reads", () => {
  const plan = planWith(() => {});
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) assert.ok(result.order.indexOf(dep) < result.order.indexOf(node.id), `${dep} before ${node.id}`);
  }
});

test("an orchestrator that is not a live text model is refused", () => {
  const notText = planWith((p) => (p.orchestrator = { provider: "openrouter", id: "black-forest-labs/flux.2-pro" }));
  const result = validatePlan(notText, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /is a image model, not a text model/);

  const unknown = planWith((p) => (p.orchestrator = { provider: "openrouter", id: "vendor/not-real" }));
  const unknownResult = validatePlan(unknown, catalog);
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.match(unknownResult.reasons.join("\n"), /not in the live catalog/);
});

test("a model the catalog does not list is refused, and the reason names the step", () => {
  const plan = planWith((p) => (step(p, "hero_still").model = { provider: "openrouter", id: "vendor/not-real" }));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /step hero_still: vendor\/not-real is not in the live catalog/);
});

test("a model of the wrong kind is refused", () => {
  const plan = planWith((p) => (step(p, "shot_1").model = { provider: "openrouter", id: "elevenlabs/eleven-multilingual-v2" }));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /is a speech model, and a video step needs a video model/);
});

test("a step that makes no model call must have no model", () => {
  const plan = planWith((p) => (step(p, "edit").model = { provider: "openrouter", id: "alibaba/wan-3.0" }));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /makes no model call and must have no model/);
});

test("a paid step with no model is refused: nothing is guessed in its place", () => {
  const plan = planWith((p) => (step(p, "shot_1").model = null));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /needs a live video model, and none was chosen/);
});

test("a paid step with no cost estimate does not run", () => {
  const plan = planWith((p) => (step(p, "shot_1").estimateUsd = null));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /shot_1: no cost estimate/);
});

test("a plan whose estimate is over budget is refused, with both totals", () => {
  const plan = planWith((p) => (p.budgetUsd = 0.5));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /estimated cost \$1\.1300 exceeds the budget \$0\.5000/);
});

test("a cycle is refused and no order is given", () => {
  const plan = planWith((p) => (step(p, "analyze_ref").dependsOn = ["render"]));
  assert.equal(topologicalOrder(plan.nodes), null);
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /cycle/);
});

test("an unknown dependency is refused", () => {
  const plan = planWith((p) => (step(p, "script").dependsOn = ["nope"]));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /script: depends on unknown step nope/);
});

test("a step that depends on itself is refused", () => {
  const plan = planWith((p) => (step(p, "script").dependsOn = ["script"]));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /depends on itself/);
});

test("duplicate step ids are refused", () => {
  const plan = planWith((p) => (p.nodes[1].id = "ref_viral"));
  const result = validatePlan(plan, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /duplicate id/);
});
