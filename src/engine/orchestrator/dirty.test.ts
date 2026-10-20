import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orchestratorPlanSchema } from "./contracts.ts";
import { cacheKeys, editNode, staleSet } from "./dirty.ts";
import { validatePlan } from "./validate.ts";
import { loadCatalog } from "./catalog.ts";

const sample = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const validated = validatePlan(sample, catalog);
if (!validated.ok) throw new Error(`sample plan must validate: ${validated.reasons.join("; ")}`);
const order = validated.order;

test("a changed step makes itself and everything downstream stale, and nothing else", () => {
  assert.deepEqual([...staleSet(sample, ["shot_1"])].sort(), ["compose", "edit", "render", "shot_1"]);
  assert.deepEqual([...staleSet(sample, ["voice"])].sort(), ["compose", "edit", "render", "voice"]);
});

test("editNode changes only the named step; every other step is the same object", () => {
  const next = editNode(sample, "shot_1", { params: { seconds: 6, aspect: "9:16", resolution: "1080p" } });
  for (const node of sample.nodes) {
    const after = next.nodes.find((candidate) => candidate.id === node.id);
    if (node.id === "shot_1") assert.equal(after?.params.seconds, 6);
    else assert.equal(after, node, `${node.id} must not change`);
  }
});

test("editNode refuses a step that is not in the plan", () => {
  assert.throws(() => editNode(sample, "nope", { params: {} }), /no step nope/);
});

test("after one surgical edit, only the edited step and its downstream keys change", () => {
  const before = cacheKeys(sample, order);
  const after = cacheKeys(editNode(sample, "shot_1", { params: { seconds: 6, aspect: "9:16", resolution: "1080p" } }), order);
  const changed = order.filter((id) => before.get(id) !== after.get(id)).sort();
  assert.deepEqual(changed, ["compose", "edit", "render", "shot_1"]);
});

test("a title or a 'why' change does not change any cache key", () => {
  const before = cacheKeys(sample, order);
  const retitled = {
    ...sample,
    nodes: sample.nodes.map((node) => (node.id === "shot_1" ? { ...node, title: "Renamed", why: "Reworded" } : node)),
  };
  const after = cacheKeys(retitled, order);
  assert.deepEqual(order.filter((id) => before.get(id) !== after.get(id)), []);
});

test("changing a model changes that step's key", () => {
  const before = cacheKeys(sample, order);
  const swapped = editNode(sample, "hero_still", { model: { provider: "openrouter", id: "bytedance-seed/seedream-4.5" } });
  const after = cacheKeys(swapped, order);
  assert.notEqual(before.get("hero_still"), after.get("hero_still"));
  assert.equal(before.get("script"), after.get("script"));
});

test("cache keys are the same for the same plan", () => {
  const a = cacheKeys(sample, order);
  const b = cacheKeys(sample, order);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});
