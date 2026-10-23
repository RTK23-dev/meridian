import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { NODE_KINDS, orchestratorPlanSchema, type NodeEvent, type OrchestratorPlan } from "./contracts.ts";
import { editNode } from "./dirty.ts";
import { CallRefusedError, NotConnectedError, StepQueuedError, runPlan, runFingerprint, type Handlers, type NodeHandler, type RunCache } from "./execute.ts";
import { loadCatalog } from "./catalog.ts";
import { KIND_CATALOG, validatePlan } from "./validate.ts";

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
const nodeById = new Map(sample.nodes.map((node) => [node.id, node]));
const estimateOf = (id: string): number => nodeById.get(id)?.estimateUsd ?? 0;

test("a handler that reports an unusable cost fails its step, and nothing is added to the spend for it", async () => {
  const paid = sample.nodes.find((node) => node.estimateUsd !== null);
  if (paid === undefined) throw new Error("the sample plan has a paid step");
  for (const bad of [Number.NaN, -0.5, Number.POSITIVE_INFINITY]) {
    const reportsBad: NodeHandler = async ({ node }) => ({ outputHash: contentHash({ id: node.id }), costUsd: bad });
    const events: NodeEvent[] = [];
    const result = await run(sample, recordingHandlers([], { [paid.kind]: reportsBad }), new Map(), events);
    assert.equal(stateOf(events, paid.id), "failed");
    assert.equal(events.filter((event) => event.nodeId === paid.id).at(-1)?.reason, "the step reported an unusable cost");
    const done = order.filter((id) => stateOf(events, id) === "done");
    const expected = done.reduce((sum, id) => sum + estimateOf(id), 0);
    assert.ok(Math.abs(result.spentUsd - expected) < 1e-9, `spent ${result.spentUsd}, expected ${expected} for ${String(bad)}`);
  }
});

test("a paid step whose handler throws holds its estimate, because the provider may have billed the call before the error", async () => {
  const paid = sample.nodes.find((node) => node.estimateUsd !== null && node.estimateUsd > 0 && KIND_CATALOG[node.kind] !== undefined);
  if (paid === undefined) throw new Error("the sample plan has a paid step with an estimate");
  const throws: NodeHandler = async () => {
    throw new Error("the provider failed after the call was billed");
  };
  const events: NodeEvent[] = [];
  const result = await run(sample, recordingHandlers([], { [paid.kind]: throws }), new Map(), events);
  assert.equal(stateOf(events, paid.id), "failed");
  // Each step that finished is charged its estimate, and each paid step that failed keeps its hold.
  const charged = order.filter((id) => {
    const node = nodeById.get(id);
    const state = stateOf(events, id);
    return state === "done" || (state === "failed" && node !== undefined && KIND_CATALOG[node.kind] !== undefined);
  });
  const expected = charged.reduce((sum, id) => sum + estimateOf(id), 0);
  assert.ok(Math.abs(result.spentUsd - expected) < 1e-9, `spent ${result.spentUsd}, expected ${expected}`);
  assert.ok(result.spentUsd >= estimateOf(paid.id), "the failed step's hold is in the spend, not zero");
});

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
  assert.match(events.find((e) => e.nodeId === "shot_1" && e.state === "paused")?.reason ?? "", /past the \$0\.5000 allowance/);
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

test("a paid step whose provider is not connected reports not_connected: it holds nothing and adds nothing to the spend", async () => {
  const paidId = order.find((id) => KIND_CATALOG[nodeById.get(id)?.kind ?? "reference"] !== undefined) ?? "";
  const kind = nodeById.get(paidId)?.kind ?? "analysis";
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const result = await run(sample, recordingHandlers(calls, { [kind]: async () => { throw new NotConnectedError("OpenRouter is not connected") } }), new Map(), events);
  assert.equal(stateOf(events, paidId), "not_connected");
  assert.equal(calls.includes(paidId), false);
  const doneCost = events.filter((event) => event.state === "done").reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  assert.equal(result.spentUsd, doneCost, "the not connected step is charged nothing");
});

test("a step is given the body of each step it reads, not its hash", async () => {
  const seen = new Map<string, Map<string, string | null>>();
  const handlers: Handlers = {};
  for (const kind of NODE_KINDS) {
    handlers[kind] = async ({ node, upstream }) => {
      seen.set(node.id, new Map(upstream));
      return { outputHash: contentHash({ id: node.id }), costUsd: null, body: `BODY:${node.id}` };
    };
  }
  await run(sample, handlers, new Map());
  for (const node of sample.nodes) {
    for (const dep of node.dependsOn) {
      assert.equal(seen.get(node.id)?.get(dep), `BODY:${dep}`, `${node.id} reads the body of ${dep}`);
    }
  }
});

test("a failed paid step records the estimate it holds on its failed event, so a later run counts it", async () => {
  const paidId = order.find((id) => KIND_CATALOG[nodeById.get(id)?.kind ?? "reference"] !== undefined) ?? "";
  const kind = nodeById.get(paidId)?.kind ?? "analysis";
  const events: NodeEvent[] = [];
  await run(sample, recordingHandlers([], { [kind]: async () => { throw new Error("the provider answered with an error") } }), new Map(), events);
  const failed = events.filter((event) => event.nodeId === paidId).at(-1);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.costUsd, estimateOf(paidId), "the held estimate is recorded");
});

test("a paid step refused before any call fails and holds nothing, so a retry does not inflate the spend", async () => {
  const paidId = order.find((id) => KIND_CATALOG[nodeById.get(id)?.kind ?? "reference"] !== undefined) ?? "";
  const kind = nodeById.get(paidId)?.kind ?? "analysis";
  const events: NodeEvent[] = [];
  const result = await run(sample, recordingHandlers([], { [kind]: async () => { throw new CallRefusedError("the budget refused this call") } }), new Map(), events);
  const failed = events.filter((event) => event.nodeId === paidId).at(-1);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.costUsd, null, "no call was made, so nothing is recorded as held");
  const doneCost = events.filter((event) => event.state === "done").reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  assert.equal(result.spentUsd, doneCost);
});

test("a step the provider accepted is queued: it holds its estimate for this run, is not done, and the steps that read it wait", async () => {
  const paid = sample.nodes.find((node) => node.estimateUsd !== null && node.estimateUsd > 0 && KIND_CATALOG[node.kind] !== undefined);
  if (paid === undefined) throw new Error("the sample plan has a paid step with an estimate");
  const queued: NodeHandler = async () => {
    throw new StepQueuedError("accepted by the provider and queued");
  };
  const events: NodeEvent[] = [];
  const result = await run(sample, recordingHandlers([], { [paid.kind]: queued }), new Map(), events);
  assert.equal(stateOf(events, paid.id), "queued");
  assert.notEqual(result.status, "complete", "a queued step is not finished");
  assert.ok(result.spentUsd >= estimateOf(paid.id), "the queued estimate is held for this run");
  const dependent = sample.nodes.find((node) => node.dependsOn.includes(paid.id));
  if (dependent !== undefined) assert.equal(stateOf(events, dependent.id), "skipped");
});
