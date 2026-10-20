import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orchestratorPlanSchema } from "./contracts.ts";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8"));

test("the recorded sample plan parses", () => {
  const plan = orchestratorPlanSchema.parse(sample);
  assert.equal(plan.nodes.length, 10);
  assert.equal(plan.version, "orchestrator-plan@1");
});

test("an unknown key on the plan or a step is refused", () => {
  assert.equal(orchestratorPlanSchema.safeParse({ ...sample, extra: true }).success, false);
  assert.equal(orchestratorPlanSchema.safeParse({ ...sample, nodes: [{ ...sample.nodes[0], extra: 1 }] }).success, false);
});

test("a model id must be vendor/model", () => {
  const bad = structuredClone(sample);
  bad.nodes[2].model = { provider: "openrouter", id: "claude-haiku" };
  assert.equal(orchestratorPlanSchema.safeParse(bad).success, false);
});

test("a live alias with a leading ~ is a valid model id", () => {
  const alias = structuredClone(sample);
  alias.nodes[2].model = { provider: "openrouter", id: "~anthropic/claude-haiku-latest" };
  assert.equal(orchestratorPlanSchema.safeParse(alias).success, true);
});

test("params are flat: a nested value is refused", () => {
  const nested = structuredClone(sample);
  nested.nodes[4].params = { hero: { line: "x" } };
  assert.equal(orchestratorPlanSchema.safeParse(nested).success, false);
});

test("a version other than orchestrator-plan@1 is refused", () => {
  assert.equal(orchestratorPlanSchema.safeParse({ ...sample, version: "orchestrator-plan@2" }).success, false);
});

test("a plan over 60 steps is refused", () => {
  const nodes = Array.from({ length: 61 }, (_, i) => ({ ...sample.nodes[0], id: `n${i}` }));
  assert.equal(orchestratorPlanSchema.safeParse({ ...sample, nodes }).success, false);
});

test("a zero or negative budget is refused", () => {
  assert.equal(orchestratorPlanSchema.safeParse({ ...sample, budgetUsd: 0 }).success, false);
  assert.equal(orchestratorPlanSchema.safeParse({ ...sample, budgetUsd: -1 }).success, false);
});
