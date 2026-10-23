import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../contracts/hash.ts";
import { NODE_KINDS, ORCHESTRATOR_PLAN_VERSION, type NodeEvent, type NodeKind, type OrchestratorPlan, type PlanNode } from "./contracts.ts";
import { StepQueuedError, runPlan, type Handlers, type NodeHandler } from "./execute.ts";
import { KIND_CATALOG } from "./validate.ts";

const MODEL = { provider: "openrouter" as const, id: "openai/gpt-test" };

/** A plan of steps with the estimates given. The executor reads each estimate as the validator left it, so nothing is priced here. */
function planOf(steps: Array<[id: string, kind: NodeKind, estimateUsd: number]>): { plan: OrchestratorPlan; order: string[] } {
  const nodes: PlanNode[] = steps.map(([id, kind, estimateUsd]) => ({
    id,
    kind,
    title: id,
    why: "a test step",
    dependsOn: [],
    model: KIND_CATALOG[kind] !== undefined ? MODEL : null,
    params: {},
    estimateUsd,
  }));
  return { plan: { version: ORCHESTRATOR_PLAN_VERSION, orchestrator: MODEL, budgetUsd: 10, nodes }, order: steps.map(([id]) => id) };
}

/** Handlers for every kind that record the step they run. A step with no cost reported is charged its estimate. */
function handlers(calls: string[], overrides: Partial<Record<NodeKind, NodeHandler>> = {}): Handlers {
  const out: Partial<Record<NodeKind, NodeHandler>> = {};
  for (const kind of NODE_KINDS) {
    out[kind] =
      overrides[kind] ??
      (async ({ node }) => {
        calls.push(node.id);
        return { outputHash: contentHash({ id: node.id }), costUsd: null };
      });
  }
  return out;
}

async function run(
  steps: Array<[id: string, kind: NodeKind, estimateUsd: number]>,
  opts: { allowanceUsd?: number; categoryAllowanceUsd?: Partial<Record<"copy" | "creative" | "voice", number>>; categorySpentUsd?: Partial<Record<"copy" | "creative" | "voice", number>> } = {},
  overrides: Partial<Record<NodeKind, NodeHandler>> = {},
) {
  const { plan, order } = planOf(steps);
  const events: NodeEvent[] = [];
  const calls: string[] = [];
  const result = await runPlan({
    plan,
    order,
    handlers: handlers(calls, overrides),
    cache: new Map(),
    emit: (event) => events.push(event),
    allowanceUsd: opts.allowanceUsd ?? 10,
    categoryAllowanceUsd: opts.categoryAllowanceUsd,
    categorySpentUsd: opts.categorySpentUsd,
  });
  return { result, events, calls };
}

/** The last event of a step: its state now, and the reason it gives. */
const eventOf = (events: NodeEvent[], id: string) => events.filter((event) => event.nodeId === id).at(-1);

describe("a category's allowance in the executor (owner direction 2026-10-23, D3)", () => {
  it("a copy allowance pauses the run before the step that would pass it, even when the total has room", async () => {
    const { result, events } = await run([
      ["a1", "analysis", 0.3],
      ["s1", "script", 0.3],
      ["v1", "visual", 0.5],
    ], { categoryAllowanceUsd: { copy: 0.5 } });
    assert.equal(result.status, "paused");
    assert.equal(eventOf(events, "a1")?.state, "done");
    assert.equal(eventOf(events, "s1")?.state, "paused");
    assert.match(eventOf(events, "s1")?.reason ?? "", /next copy step.*\$0\.6000.*\$0\.5000 allowance for copy steps/);
    assert.equal(eventOf(events, "v1")?.state, "planned", "the run stops at the pause, so nothing after it runs");
    assert.ok(Math.abs(result.spentUsd - 0.3) < 1e-9);
  });

  it("the first cent past a category's allowance pauses, and a step that stays inside it runs", async () => {
    const within = await run([["a1", "analysis", 0.3], ["s1", "script", 0.21]], { categoryAllowanceUsd: { copy: 0.51 } });
    assert.equal(within.result.status, "complete");
    const past = await run([["a1", "analysis", 0.3], ["s1", "script", 0.22]], { categoryAllowanceUsd: { copy: 0.51 } });
    assert.equal(past.result.status, "paused");
  });

  it("a category with no allowance of its own is held only by the total: a brief that sets no copy budget is delegated", async () => {
    const { result } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.3]], { allowanceUsd: 10 });
    assert.equal(result.status, "complete");
  });

  it("the total still binds inside a category: a step past the plan's allowance pauses with the total's reason", async () => {
    const { events } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.3]], { allowanceUsd: 0.4, categoryAllowanceUsd: { copy: 10 } });
    assert.equal(eventOf(events, "s1")?.state, "paused");
    assert.doesNotMatch(eventOf(events, "s1")?.reason ?? "", /copy/);
  });

  it("spend from earlier runs counts toward the category's allowance, so a re-run cannot start past it", async () => {
    const { result, events, calls } = await run([["a1", "analysis", 0.3]], { categoryAllowanceUsd: { copy: 0.5 }, categorySpentUsd: { copy: 0.4 } });
    assert.equal(result.status, "paused");
    assert.equal(eventOf(events, "a1")?.state, "paused");
    assert.deepEqual(calls, [], "no handler is called for a step that would pass the allowance");
  });

  it("a failed step's hold counts toward its category, because the provider may have billed the call before the error", async () => {
    const fails: NodeHandler = async () => {
      throw new Error("the provider failed after the call was billed");
    };
    const { result, events, calls } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.3]], { categoryAllowanceUsd: { copy: 0.5 } }, { analysis: fails });
    assert.equal(eventOf(events, "a1")?.state, "failed");
    assert.equal(eventOf(events, "s1")?.state, "paused", "the held 0.3 of the failed step takes the copy spend past the allowance");
    assert.equal(result.status, "paused");
    assert.deepEqual(calls, []);
  });

  it("a queued asset holds its estimate for its category, so the next step of that category waits for an approval", async () => {
    const queued: NodeHandler = async () => {
      throw new StepQueuedError("the video is queued at its provider");
    };
    const { result, events } = await run([["p1", "avatar", 0.4], ["m1", "video", 0.2]], { categoryAllowanceUsd: { creative: 0.5 } }, { avatar: queued });
    assert.equal(eventOf(events, "p1")?.state, "queued");
    assert.equal(eventOf(events, "m1")?.state, "paused");
    assert.equal(result.status, "paused");
  });

  it("each category is held to its own allowance: a voice step is not held by the copy allowance", async () => {
    const { result } = await run([["a1", "analysis", 0.3], ["vo1", "voice", 0.9]], { categoryAllowanceUsd: { copy: 0.5 } });
    assert.equal(result.status, "complete");
  });
});
