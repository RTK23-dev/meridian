import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { NODE_KINDS, orchestratorPlanSchema, type NodeEvent, type OrchestratorPlan } from "./contracts.ts";
import { editNode } from "./dirty.ts";
import { runPlan, runFingerprint, type Handlers, type NodeHandler, type RunCache } from "./execute.ts";
import { loadCatalog } from "./catalog.ts";
import { validatePlan } from "./validate.ts";

const sample = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const validated = validatePlan(sample, catalog);
if (!validated.ok) throw new Error(`sample plan must validate: ${validated.reasons.join("; ")}`);
const order = validated.order;

/** Recorded handlers: each returns a deterministic output and no actual cost, so the run charges the estimate. */
function recordingHandlers(calls: string[], overrides: Partial<Record<string, NodeHandler>> = {}): Handlers {
  const make =
    (kind: string): NodeHandler =>
    async ({ node }) => {
      calls.push(node.id);
      return { outputHash: contentHash({ id: node.id, kind }), costUsd: null };
    };
  const handlers: Record<string, NodeHandler> = {};
  for (const kind of NODE_KINDS) handlers[kind] = overrides[kind] ?? make(kind);
  return handlers as Handlers;
}

async function run(plan: OrchestratorPlan, handlers: Handlers, cache: RunCache, events: NodeEvent[] = []) {
  return runPlan({ plan, order, handlers, cache, emit: (event) => events.push(event) });
}

const stateOf = (events: NodeEvent[], id: string) => events.filter((event) => event.nodeId === id).at(-1)?.state;

test("a full run finishes every step, in order, and charges each estimate", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const result = await run(sample, recordingHandlers(calls), new Map(), events);
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, order);
  assert.ok(Math.abs(result.spentUsd - 1.13) < 1e-9, `spent ${result.spentUsd}`);
  assert.deepEqual(events.slice(0, order.length).map((event) => event.state), order.map(() => "planned"));
  for (const id of order) assert.equal(stateOf(events, id), "done");
});

test("a second run with the same cache costs nothing and calls no handler", async () => {
  const cache: RunCache = new Map();
  await run(sample, recordingHandlers([]), cache);
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const result = await run(sample, recordingHandlers(calls), cache, events);
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, []);
  assert.equal(result.spentUsd, 0);
  for (const id of order) assert.equal(stateOf(events, id), "cache_hit");
});

test("after one surgical edit, only the edited step and its downstream steps run again", async () => {
  const cache: RunCache = new Map();
  await run(sample, recordingHandlers([]), cache);

  const edited = editNode(sample, "shot_1", { params: { seconds: 6, aspect: "9:16", resolution: "1080p" } });
  const editedOrder = validatePlan(edited, catalog);
  assert.equal(editedOrder.ok, true);
  if (!editedOrder.ok) return;

  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const result = await runPlan({ plan: edited, order: editedOrder.order, handlers: recordingHandlers(calls), cache, emit: (e) => events.push(e) });
  assert.equal(result.status, "complete");
  assert.deepEqual([...calls].sort(), ["compose", "edit", "render", "shot_1"]);
  for (const id of ["ref_viral", "brand", "analyze_ref", "script", "hero_still", "voice"]) assert.equal(stateOf(events, id), "cache_hit");
});

test("a step with no handler is not_connected: it does not run, and the steps that read it are skipped", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const handlers = recordingHandlers(calls);
  delete handlers.video;
  const result = await runPlan({ plan: sample, order, handlers, cache: new Map(), emit: (e) => events.push(e) });
  assert.equal(result.status, "incomplete");
  assert.equal(stateOf(events, "shot_1"), "not_connected");
  assert.match(events.find((e) => e.nodeId === "shot_1" && e.state === "not_connected")?.reason ?? "", /no handler for video/);
  for (const id of ["edit", "compose", "render"]) assert.equal(stateOf(events, id), "skipped");
  assert.equal(stateOf(events, "voice"), "done");
  assert.equal(calls.includes("shot_1"), false);
});

test("a handler that throws fails its step, skips its readers, and cuts the message at 300 characters", async () => {
  const events: NodeEvent[] = [];
  const handlers = recordingHandlers([], {
    video: async () => {
      throw new Error("x".repeat(500));
    },
  });
  const result = await runPlan({ plan: sample, order, handlers, cache: new Map(), emit: (e) => events.push(e) });
  assert.equal(result.status, "incomplete");
  const failed = events.find((e) => e.nodeId === "shot_1" && e.state === "failed");
  assert.equal(failed?.reason?.length, 300);
  for (const id of ["edit", "compose", "render"]) assert.equal(stateOf(events, id), "skipped");
});

test("the run pauses before a step that would overrun the budget, and calls nothing after it", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const tight: OrchestratorPlan = { ...sample, budgetUsd: 0.5 };
  const result = await runPlan({ plan: tight, order, handlers: recordingHandlers(calls), cache: new Map(), emit: (e) => events.push(e) });
  assert.equal(result.status, "paused");
  assert.equal(stateOf(events, "shot_1"), "paused");
  assert.match(events.find((e) => e.nodeId === "shot_1" && e.state === "paused")?.reason ?? "", /the run stops here/);
  assert.equal(calls.includes("shot_1"), false);
  assert.ok(result.spentUsd <= 0.5, `spent ${result.spentUsd} must not exceed the budget`);
});

test("a paused run that resumes with a bigger budget ends with the same outputs as a run that never paused", async () => {
  const cache: RunCache = new Map();
  const paused = await runPlan({ plan: { ...sample, budgetUsd: 0.5 }, order, handlers: recordingHandlers([]), cache, emit: () => {} });
  assert.equal(paused.status, "paused");
  const resumed = await runPlan({ plan: sample, order, handlers: recordingHandlers([]), cache, emit: () => {} });
  assert.equal(resumed.status, "complete");
  const clean = await runPlan({ plan: sample, order, handlers: recordingHandlers([]), cache: new Map(), emit: () => {} });
  assert.equal(runFingerprint(resumed.outputs), runFingerprint(clean.outputs));
});

test("a paid step with no estimate fails before any call is made", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const noEstimate = editNode(sample, "shot_1", {});
  const patched: OrchestratorPlan = {
    ...noEstimate,
    nodes: noEstimate.nodes.map((node) => (node.id === "shot_1" ? { ...node, estimateUsd: null } : node)),
  };
  await runPlan({ plan: patched, order, handlers: recordingHandlers(calls), cache: new Map(), emit: (e) => events.push(e) });
  assert.equal(stateOf(events, "shot_1"), "failed");
  assert.equal(calls.includes("shot_1"), false);
});
