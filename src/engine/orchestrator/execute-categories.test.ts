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

/** Handlers for every kind that record the step they run. A step with no cost reported is charged its hold. */
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

type Category = "copy" | "creative" | "voice";

async function run(
  steps: Array<[id: string, kind: NodeKind, estimateUsd: number]>,
  opts: { lineUsd?: number; categoryLinesUsd?: Partial<Record<Category, number>>; categorySpentUsd?: Partial<Record<Category, number>> } = {},
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
    lineUsd: opts.lineUsd ?? 10,
    categoryLinesUsd: opts.categoryLinesUsd,
    categorySpentUsd: opts.categorySpentUsd,
  });
  return { result, events, calls };
}

/** The last event of a step: its state now, and the reason it gives. */
const eventOf = (events: NodeEvent[], id: string) => events.filter((event) => event.nodeId === id).at(-1);

describe("a category's line in the executor (owner direction 2026-10-23, D3, D12)", () => {
  it("a copy step whose hold would take the copy spend past its line pauses the run, even when the total has room", async () => {
    const { result, events, calls } = await run(
      [
        ["a1", "analysis", 0.3],
        ["s1", "script", 0.3],
        ["v1", "visual", 0.5],
      ],
      { categoryLinesUsd: { copy: 0.5 } },
    );
    assert.equal(result.status, "paused");
    assert.equal(eventOf(events, "a1")?.state, "done", "$0.30 fits the $0.50 copy line");
    assert.equal(eventOf(events, "s1")?.state, "paused");
    assert.equal(
      eventOf(events, "s1")?.reason,
      "copy budget reached, project not finished: the next step's hold of $0.3000 would take the spend past the $0.5000 copy budget (committed $0.3000)",
    );
    assert.equal(eventOf(events, "v1")?.state, "planned", "the run stops at the pause, so nothing after it runs");
    assert.deepEqual(calls, ["a1"]);
    assert.ok(Math.abs(result.spentUsd - 0.3) < 1e-9);
  });

  it("a category step starts while its committed spend is below its line; the first one that starts at the line pauses", async () => {
    const within = await run([["a1", "analysis", 0.3], ["s1", "script", 0.21]], { categoryLinesUsd: { copy: 0.51 } });
    assert.equal(within.result.status, "complete", "$0.30 is below $0.51, so the second step starts and the run finishes");
    const atLine = await run([["a1", "analysis", 0.3], ["s1", "script", 0.21]], { categoryLinesUsd: { copy: 0.3 } });
    assert.equal(atLine.result.status, "paused", "$0.30 is at the $0.30 line, so the second step does not start");
    assert.equal(eventOf(atLine.events, "s1")?.state, "paused");
  });

  it("a bill above its estimate takes the copy spend past its line, and the overshoot is recorded (D17: a hold never overshoots)", async () => {
    // The script's hold ($0.20) fits the $0.50 line after the analysis ($0.30). Its bill then comes in at $0.90: the overshoot is recorded.
    const billed: NodeHandler = async ({ node }) => ({ outputHash: contentHash({ id: node.id }), costUsd: 0.9 });
    const { result, events } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.2]], { categoryLinesUsd: { copy: 0.5 } }, { script: billed });
    assert.equal(result.status, "complete", "no further paid step starts after the overshoot, so the run finishes");
    assert.equal(eventOf(events, "s1")?.costUsd, 0.9, "the bill is recorded in full");
    assert.ok(Math.abs(result.spentUsd - 1.2) < 1e-9, `spent ${result.spentUsd}`);
  });

  it("a hold that would take the copy spend past its line does not start, even though the copy spend is below the line", async () => {
    const { result, events, calls } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.9]], { categoryLinesUsd: { copy: 0.5 } });
    assert.equal(eventOf(events, "s1")?.state, "paused", "$0.30 is below $0.50, but a $0.90 hold would take it to $1.20");
    assert.equal(result.status, "paused");
    assert.equal(calls.includes("s1"), false, "no request is made for the step");
  });

  it("a category with no line of its own is held only by the total: a brief that sets no copy budget is delegated", async () => {
    const { result } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.3]], { lineUsd: 10 });
    assert.equal(result.status, "complete");
  });

  it("the total still binds inside a category: a step whose hold would take the total past its line pauses with the total's reason", async () => {
    const { events } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.3]], { lineUsd: 0.35, categoryLinesUsd: { copy: 10 } });
    assert.equal(eventOf(events, "a1")?.state, "done", "$0.30 fits the $0.35 total");
    assert.equal(eventOf(events, "s1")?.state, "paused");
    assert.equal(
      eventOf(events, "s1")?.reason,
      "budget reached, project not finished: the next step's hold of $0.3000 would take the spend past the $0.3500 budget (committed $0.3000)",
    );
    assert.doesNotMatch(eventOf(events, "s1")?.reason ?? "", /copy/);
  });

  it("spend from earlier runs counts toward the category's line, so a re-run cannot start past it", async () => {
    const { result, events, calls } = await run([["a1", "analysis", 0.3]], { categoryLinesUsd: { copy: 0.5 }, categorySpentUsd: { copy: 0.5 } });
    assert.equal(result.status, "paused");
    assert.equal(eventOf(events, "a1")?.state, "paused");
    assert.match(eventOf(events, "a1")?.reason ?? "", /^copy budget reached, project not finished/);
    assert.deepEqual(calls, [], "no handler is called for a step that would start at the line");
  });

  it("a failed step's hold counts toward its category, because the provider may have billed the call before the error", async () => {
    const fails: NodeHandler = async () => {
      throw new Error("the provider failed after the call was billed");
    };
    const { result, events, calls } = await run([["a1", "analysis", 0.3], ["s1", "script", 0.3]], { categoryLinesUsd: { copy: 0.3 } }, { analysis: fails });
    assert.equal(eventOf(events, "a1")?.state, "failed");
    assert.equal(eventOf(events, "s1")?.state, "paused", "the held $0.30 of the failed step is the copy spend, which is at the line");
    assert.equal(result.status, "paused");
    assert.deepEqual(calls, []);
  });

  it("a queued asset holds its hold for its category, so the next step of that category waits at the line", async () => {
    const queued: NodeHandler = async () => {
      throw new StepQueuedError("the video is queued at its provider");
    };
    const { result, events } = await run([["p1", "avatar", 0.5], ["m1", "video", 0.2]], { categoryLinesUsd: { creative: 0.5 } }, { avatar: queued });
    assert.equal(eventOf(events, "p1")?.state, "queued");
    assert.equal(eventOf(events, "m1")?.state, "paused");
    assert.equal(result.status, "paused");
  });

  it("each category is held to its own line: a voice step is not held by the copy line", async () => {
    const { result } = await run([["a1", "analysis", 0.3], ["vo1", "voice", 0.9]], { categoryLinesUsd: { copy: 0.5 } });
    assert.equal(result.status, "complete");
  });
});
