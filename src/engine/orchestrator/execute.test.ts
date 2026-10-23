import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { NODE_KINDS, orchestratorPlanSchema, type NodeEvent, type NodeKind, type OrchestratorPlan } from "./contracts.ts";
import { editNode } from "./dirty.ts";
import { CallRefusedError, NotConnectedError, StepQueuedError, runPlan, runFingerprint, type Handlers, type NodeHandler, type RunCache } from "./execute.ts";
import { loadCatalog } from "./catalog.ts";
import { KIND_CATALOG, validatePlan } from "./validate.ts";

const sample = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const validated = validatePlan(sample, catalog);
if (!validated.ok) throw new Error(`sample plan must validate: ${validated.reasons.join("; ")}`);
const order = validated.order;

/** Recorded handlers: each returns a deterministic output and no actual cost, so the run charges the hold. */
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
const reasonOf = (events: NodeEvent[], id: string, state: NodeEvent["state"]) => events.find((event) => event.nodeId === id && event.state === state)?.reason ?? "";
const nodeById = new Map(sample.nodes.map((node) => [node.id, node]));
const estimateOf = (id: string): number => nodeById.get(id)?.estimateUsd ?? 0;

test("a handler that reports an unusable cost fails its step, and its hold is charged: an unusable figure is not a free call", async () => {
  const paid = sample.nodes.find((node) => node.estimateUsd !== null);
  if (paid === undefined) throw new Error("the sample plan has a paid step");
  // Not a number, negative, not finite, or a string where a number belongs.
  for (const bad of [Number.NaN, -0.5, Number.POSITIVE_INFINITY, "0.5" as unknown as number]) {
    const reportsBad: NodeHandler = async ({ node }) => ({ outputHash: contentHash({ id: node.id }), costUsd: bad });
    const events: NodeEvent[] = [];
    const result = await run(sample, recordingHandlers([], { [paid.kind]: reportsBad }), new Map(), events);
    const failed = events.filter((event) => event.nodeId === paid.id).at(-1);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.reason, "the step reported an unusable cost");
    assert.equal(failed?.costUsd, estimateOf(paid.id), "the step's hold is charged, as a failed step's is");
    const done = order.filter((id) => stateOf(events, id) === "done");
    const expected = done.reduce((sum, id) => sum + estimateOf(id), 0) + estimateOf(paid.id);
    assert.ok(Math.abs(result.spentUsd - expected) < 1e-9, `spent ${result.spentUsd}, expected ${expected} for ${String(bad)}`);
  }
});

test("an output the store refuses to keep fails its step: the bill stays counted on its failed event, nothing is cached, and its readers wait", async () => {
  const billed: NodeHandler = async ({ node }) => ({ outputHash: contentHash({ id: node.id }), costUsd: 0.5 });
  const events: NodeEvent[] = [];
  const cache: RunCache = new Map();
  const kept: string[] = [];
  const result = await runPlan({
    plan: sample,
    order,
    handlers: recordingHandlers([], { analysis: billed }),
    cache,
    emit: (event) => events.push(event),
    onOutput: async (output) => {
      if (output.nodeId === "analyze_ref") throw new Error("the database refused the write");
      kept.push(output.nodeId);
    },
  });
  const failed = events.filter((event) => event.nodeId === "analyze_ref").at(-1);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.costUsd, 0.5, "the bill is on the failed event, so a later run counts it");
  assert.equal(failed?.reason, "the output could not be stored, so the step is not kept: the database refused the write");
  assert.equal(stateOf(events, "script"), "skipped", "the step that reads the unkept output waits");
  assert.equal(result.status, "incomplete");
  assert.ok(Math.abs(result.spentUsd - 0.5) < 1e-9, `spent ${result.spentUsd}: the bill is spent`);
  assert.equal(cache.size, kept.length, "only the outputs that were kept are cached");
});

test("a budget line that refuses a call pauses the run at that step: the step is not failed, nothing after it starts, and nothing is held for it", async () => {
  const budgetRefusal = "so it was not made: ";
  const cases: Array<{ kind: NodeKind; message: string }> = [
    {
      kind: "analysis",
      message: `the budget refused this call, ${budgetRefusal}the workspace month has committed 5 USD, at or above its 5 USD budget, so no paid call starts`,
    },
    {
      kind: "video",
      message: `the budget refused this video, ${budgetRefusal}openrouter:video: call video would take the request to 0.9 USD, above its 0.5 USD budget, so it does not start`,
    },
  ];
  for (const { kind, message } of cases) {
    const stepId = sample.nodes.find((node) => node.kind === kind)?.id ?? "";
    const events: NodeEvent[] = [];
    const refused: NodeHandler = async () => {
      throw new CallRefusedError(message);
    };
    const result = await run(sample, recordingHandlers([], { [kind]: refused }), new Map(), events);
    assert.equal(result.status, "paused", `${kind}: the run pauses`);
    assert.equal(stateOf(events, stepId), "paused", `${kind}: the step is paused`);
    // A refused call never ran: its pause carries no cost, and no failed event is written for it, so no hold is charged.
    assert.equal(events.filter((event) => event.nodeId === stepId).at(-1)?.costUsd, null, `${kind}: a refused call charges nothing`);
    assert.equal(
      events.some((event) => event.nodeId === stepId && event.state === "failed"),
      false,
      `${kind}: the step is not failed`,
    );
    assert.equal(reasonOf(events, stepId, "paused"), `budget reached, project not finished: ${message.slice(message.indexOf(budgetRefusal) + budgetRefusal.length)}`);
    for (const id of order.slice(order.indexOf(stepId) + 1)) assert.equal(stateOf(events, id), "planned", `${id} does not start after the pause`);
    const before = order.slice(0, order.indexOf(stepId));
    const expected = before.reduce((sum, id) => sum + estimateOf(id), 0);
    assert.ok(Math.abs(result.spentUsd - expected) < 1e-9, `spent ${result.spentUsd}, expected ${expected}: the paused step adds nothing`);
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

test("a hold that exactly fits starts, and the run stops at the line before the next paid step", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  // The line is $0.12. analyze_ref ($0.02) and script ($0.10) fit it exactly: the script's hold takes the spend to the line, so it starts.
  // hero_still starts at the line, so it pauses before its call.
  const result = await runPlan({ plan: sample, order, handlers: recordingHandlers(calls), cache: new Map(), emit: (e) => events.push(e), lineUsd: 0.12 });
  assert.equal(stateOf(events, "script"), "done", "a hold that fits starts");
  assert.equal(result.status, "paused");
  assert.equal(stateOf(events, "hero_still"), "paused");
  assert.equal(
    reasonOf(events, "hero_still", "paused"),
    "budget reached, project not finished: the next step's hold of $0.0600 would take the spend past the $0.1200 budget (committed $0.1200)",
  );
  assert.equal(calls.includes("hero_still"), false, "the paused step is not called");
  assert.equal(calls.includes("shot_1"), false, "nothing after the pause starts");
  assert.ok(Math.abs(result.spentUsd - 0.12) < 1e-9, `spent ${result.spentUsd}`);
});

test("a hold that does not fit pauses the run before its call, with the reason; the steps before it still run and add nothing", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  // The line is $0.10. analyze_ref ($0.02) fits. script's hold ($0.10) would take the spend to $0.12, past the line, so it does not start.
  const result = await runPlan({ plan: sample, order, handlers: recordingHandlers(calls), cache: new Map(), emit: (e) => events.push(e), lineUsd: 0.1 });
  assert.equal(result.status, "paused");
  assert.equal(stateOf(events, "analyze_ref"), "done", "the step before the pause still runs");
  assert.equal(stateOf(events, "script"), "paused");
  assert.equal(
    reasonOf(events, "script", "paused"),
    "budget reached, project not finished: the next step's hold of $0.1000 would take the spend past the $0.1000 budget (committed $0.0200)",
  );
  assert.equal(calls.includes("script"), false, "no request is made for a hold that does not fit");
  assert.equal(calls.includes("hero_still"), false, "nothing after the pause starts");
  assert.ok(Math.abs(result.spentUsd - 0.02) < 1e-9, `spent ${result.spentUsd}: the paused step adds nothing`);
});

test("a zero-estimate paid step at the line does not start: the line is checked alongside the fit (D17)", async () => {
  const zeroPlan: OrchestratorPlan = {
    version: sample.version,
    orchestrator: sample.orchestrator,
    budgetUsd: 1,
    nodes: [
      { id: "a1", kind: "analysis", title: "a1", why: "a test step", dependsOn: [], model: null, params: {}, estimateUsd: 0.5 },
      { id: "s1", kind: "script", title: "s1", why: "a test step", dependsOn: ["a1"], model: null, params: {}, estimateUsd: 0 },
    ],
  };
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const result = await runPlan({ plan: zeroPlan, order: ["a1", "s1"], handlers: recordingHandlers(calls), cache: new Map(), emit: (e) => events.push(e), lineUsd: 0.5 });
  assert.equal(stateOf(events, "a1"), "done");
  assert.equal(stateOf(events, "s1"), "paused", "the spend is at the line, so a step of no cost still does not start");
  assert.equal(calls.includes("s1"), false);
  assert.equal(result.status, "paused");
});

test("a zero-estimate paid step below the line starts, and its zero hold adds nothing", async () => {
  const zeroPlan: OrchestratorPlan = {
    version: sample.version,
    orchestrator: sample.orchestrator,
    budgetUsd: 1,
    nodes: [
      { id: "a1", kind: "analysis", title: "a1", why: "a test step", dependsOn: [], model: null, params: {}, estimateUsd: 0.5 },
      { id: "s1", kind: "script", title: "s1", why: "a test step", dependsOn: ["a1"], model: null, params: {}, estimateUsd: 0 },
    ],
  };
  const calls: string[] = [];
  const result = await runPlan({ plan: zeroPlan, order: ["a1", "s1"], handlers: recordingHandlers(calls), cache: new Map(), emit: () => {}, lineUsd: 1 });
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, ["a1", "s1"]);
  assert.ok(Math.abs(result.spentUsd - 0.5) < 1e-9);
});

test("a call in flight finishes, and its cost may take the spend past the line: the overshoot is recorded", async () => {
  const events: NodeEvent[] = [];
  // The line is $0.15. The script's hold ($0.10) fits after the analysis ($0.02), so it starts. Its call then finishes at $0.50, a bill above its
  // estimate, so the spend is $0.52 when hero_still is reached: the overshoot is recorded, and hero_still does not start.
  const handlers = recordingHandlers([], { script: async ({ node }) => ({ outputHash: contentHash({ id: node.id }), costUsd: 0.5 }) });
  const result = await runPlan({ plan: sample, order, handlers, cache: new Map(), emit: (e) => events.push(e), lineUsd: 0.15 });
  assert.equal(stateOf(events, "script"), "done");
  assert.equal(events.find((e) => e.nodeId === "script" && e.state === "done")?.costUsd, 0.5, "the call's own cost is recorded");
  assert.equal(stateOf(events, "hero_still"), "paused");
  assert.ok(Math.abs(result.spentUsd - 0.52) < 1e-9, `spent ${result.spentUsd}: the analysis $0.02, then the script's $0.50`);
});

test("a paused run that resumes with a bigger budget ends with the same outputs as a run that never paused", async () => {
  const cache: RunCache = new Map();
  const paused = await runPlan({ plan: sample, order, handlers: recordingHandlers([]), cache, emit: () => {}, lineUsd: 0.1 });
  assert.equal(paused.status, "paused");
  const resumed = await runPlan({ plan: sample, order, handlers: recordingHandlers([]), cache, emit: () => {} });
  assert.equal(resumed.status, "complete");
  const clean = await runPlan({ plan: sample, order, handlers: recordingHandlers([]), cache: new Map(), emit: () => {} });
  assert.equal(runFingerprint(resumed.outputs), runFingerprint(clean.outputs));
});

test("a paid step with no estimate and no measure mode fails before any call is made, and says it has no price", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const noEstimate = editNode(sample, "shot_1", {});
  const patched: OrchestratorPlan = {
    ...noEstimate,
    nodes: noEstimate.nodes.map((node) => (node.id === "shot_1" ? { ...node, estimateUsd: null } : node)),
  };
  await runPlan({ plan: patched, order, handlers: recordingHandlers(calls), cache: new Map(), emit: (e) => events.push(e) });
  assert.equal(stateOf(events, "shot_1"), "failed");
  assert.equal(reasonOf(events, "shot_1", "failed"), "the step has no price, and measure mode is off, so it did not run");
  assert.equal(calls.includes("shot_1"), false);
});

test("measure mode holds an unpriced video to its ceiling times its length, and the hold is charged when no bill is reported", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const unpriced: OrchestratorPlan = {
    ...sample,
    nodes: sample.nodes.map((node) => (node.id === "shot_1" ? { ...node, estimateUsd: null } : node)),
  };
  const result = await runPlan({
    plan: unpriced,
    order,
    handlers: recordingHandlers(calls),
    cache: new Map(),
    emit: (e) => events.push(e),
    measure: { ceilingUsdPerSecond: 0.5 },
    lineUsd: 3,
  });
  // Five seconds at a $0.50 ceiling is a $2.50 hold. The steps before it cost $0.23, so the hold fits a $3.00 line and the run ends at $2.73.
  assert.equal(stateOf(events, "shot_1"), "done");
  assert.equal(events.find((e) => e.nodeId === "shot_1" && e.state === "done")?.costUsd, 2.5);
  assert.ok(calls.includes("shot_1"));
  assert.ok(Math.abs(result.spentUsd - 2.73) < 1e-9, `spent ${result.spentUsd}`);
  assert.equal(result.status, "complete");
});

test("a measured video whose provider reports its bill is charged that bill, not the ceiling", async () => {
  const events: NodeEvent[] = [];
  const unpriced: OrchestratorPlan = {
    ...sample,
    nodes: sample.nodes.map((node) => (node.id === "shot_1" ? { ...node, estimateUsd: null } : node)),
  };
  const billed: NodeHandler = async ({ node }) => ({ outputHash: contentHash({ id: node.id }), costUsd: 1.25 });
  await runPlan({ plan: unpriced, order, handlers: recordingHandlers([], { video: billed }), cache: new Map(), emit: (e) => events.push(e), measure: { ceilingUsdPerSecond: 0.5 }, lineUsd: 3 });
  assert.equal(events.find((e) => e.nodeId === "shot_1" && e.state === "done")?.costUsd, 1.25);
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

test("a failed paid step records the hold it keeps on its failed event, so a later run counts it", async () => {
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

test("a step the provider accepted is queued: it holds its hold for this run, is not done, and the steps that read it wait", async () => {
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

test("a step whose job is already waiting reports queued: the line does not hold it, it calls nothing, and it adds no spend", async () => {
  const cache: RunCache = new Map();
  // The first run stores every step but the video, which has no handler yet, so the video is the only step left to run.
  const withoutVideo = recordingHandlers([]);
  delete withoutVideo.video;
  await runPlan({ plan: sample, order, handlers: withoutVideo, cache, emit: () => {} });

  const calls: string[] = [];
  const events: NodeEvent[] = [];
  // The video's job is waiting, so its hold ($0.90) is already in the starting spend. The line ($0.50) is already reached.
  const result = await runPlan({
    plan: sample,
    order,
    handlers: recordingHandlers(calls),
    cache,
    emit: (e) => events.push(e),
    spentUsd: 0.9,
    lineUsd: 0.5,
    queued: new Set(["shot_1"]),
  });
  assert.equal(stateOf(events, "shot_1"), "queued");
  assert.match(reasonOf(events, "shot_1", "queued"), /still queued at its provider/);
  assert.equal(calls.includes("shot_1"), false, "nothing is submitted for a waiting job");
  assert.equal(result.spentUsd, 0.9, "its hold is already in the starting spend, so nothing is added");
  assert.equal(result.status, "incomplete", "the steps that read the waiting video wait for its poll");
  assert.equal(stateOf(events, "edit"), "skipped");
});

test("a measured hold is held to the line like any other: a video whose ceiling does not fit pauses before its call", async () => {
  const calls: string[] = [];
  const events: NodeEvent[] = [];
  const unpriced: OrchestratorPlan = {
    ...sample,
    nodes: sample.nodes.map((node) => (node.id === "shot_1" ? { ...node, estimateUsd: null } : node)),
  };
  const result = await runPlan({
    plan: unpriced,
    order,
    handlers: recordingHandlers(calls),
    cache: new Map(),
    emit: (e) => events.push(e),
    measure: { ceilingUsdPerSecond: 0.5 },
    lineUsd: 2,
  });
  // The $2.50 ceiling for five seconds would take the $0.23 committed before it past a $2.00 line, so the video does not start.
  assert.equal(stateOf(events, "shot_1"), "paused");
  assert.equal(
    reasonOf(events, "shot_1", "paused"),
    "budget reached, project not finished: the next step's hold of $2.5000 would take the spend past the $2.0000 budget (committed $0.2300)",
  );
  assert.equal(calls.includes("shot_1"), false, "no request is made for a hold that does not fit");
  assert.equal(result.status, "paused");
});
