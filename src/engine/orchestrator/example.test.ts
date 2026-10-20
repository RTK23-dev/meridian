import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";
import { examplePlanRaw } from "./fixtures/example-plan.ts";
import { exampleEvents } from "./fixtures/example-events.ts";
import { examplePlan, recordedExampleRun } from "./example.ts";
import { validatePlan } from "./validate.ts";

const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

test("the TypeScript example plan is the same content as the JSON fixture", () => {
  const json = JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8"));
  assert.deepEqual(examplePlanRaw, json);
});

test("the example plan validates against the recorded live catalog", () => {
  assert.equal(validatePlan(examplePlan, catalog).ok, true);
});

test("the recorded example run finishes every step, and none is left waiting", async () => {
  const { events } = await recordedExampleRun();
  const last = new Map<string, string>();
  for (const event of events) last.set(event.nodeId, event.state);
  assert.equal(last.size, examplePlan.nodes.length);
  for (const [id, state] of last) assert.equal(state, "done", `${id} should be done`);
});

test("the stored example events are the events a fresh run produces", async () => {
  const { events } = await recordedExampleRun();
  assert.deepEqual(exampleEvents, events);
});
