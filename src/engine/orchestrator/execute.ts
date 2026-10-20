// Runs a validated plan one step at a time, in order, and reports each step as it changes. Fail closed:
// - a step with no handler for its kind is `not_connected`: it does not run and returns no output;
// - a step whose handler throws is `failed`, and every step that reads it is `skipped`;
// - a step whose estimate would take the run past the budget is never started: the run `paused` there and nothing else runs.
// Cache hits are reported as `cache_hit` and cost nothing. The handlers are injected, so this file calls no provider.

import { contentHash } from "../contracts/hash.ts";
import type { NodeEvent, NodeKind, NodeState, OrchestratorPlan, PlanNode } from "./contracts.ts";
import { cacheKeys } from "./dirty.ts";
import { KIND_CATALOG } from "./validate.ts";

export type NodeOutput = { outputHash: string; costUsd: number | null };

export type NodeHandler = (input: { node: PlanNode; key: string; upstream: Map<string, string> }) => Promise<NodeOutput>;

export type Handlers = Partial<Record<NodeKind, NodeHandler>>;

/** Outputs kept between runs, by cache key. A cache hit reuses an output of an identical step. */
export type RunCache = Map<string, NodeOutput>;

export type RunResult = {
  status: "complete" | "paused" | "incomplete";
  /** What the run has spent. A step that reports no actual cost is charged its estimate, so the run never assumes a free call. */
  spentUsd: number;
  outputs: Map<string, string>;
};

const REASON_MAX = 300;

export async function runPlan(opts: {
  plan: OrchestratorPlan;
  order: string[];
  handlers: Handlers;
  cache: RunCache;
  emit: (event: NodeEvent) => void;
  /** What earlier runs of this plan have spent. */
  spentUsd?: number;
}): Promise<RunResult> {
  const { plan, order, handlers, cache, emit } = opts;
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const keys = cacheKeys(plan, order);
  const states = new Map<string, NodeState>();
  const outputs = new Map<string, string>();
  let spent = opts.spentUsd ?? 0;

  const set = (nodeId: string, state: NodeState, outputHash: string | null, costUsd: number | null, reason: string | null) => {
    states.set(nodeId, state);
    emit({ nodeId, state, outputHash, costUsd, reason });
  };

  for (const id of order) set(id, "planned", null, null, null);

  let paused = false;
  for (const id of order) {
    const node = byId.get(id);
    if (!node) throw new Error(`no step ${id} in this plan`);

    const blocker = node.dependsOn.find((dep) => states.get(dep) !== "done" && states.get(dep) !== "cache_hit");
    if (blocker !== undefined) {
      set(id, "skipped", null, null, `waits on ${blocker}, which did not finish`);
      continue;
    }

    const key = keys.get(id);
    if (key === undefined) throw new Error(`no cache key for step ${id}`);

    const hit = cache.get(key);
    if (hit !== undefined) {
      outputs.set(id, hit.outputHash);
      set(id, "cache_hit", hit.outputHash, 0, null);
      continue;
    }

    const handler = handlers[node.kind];
    if (handler === undefined) {
      set(id, "not_connected", null, null, `no handler for ${node.kind} steps; the step did not run and has no output`);
      continue;
    }

    const paidKind = KIND_CATALOG[node.kind] !== undefined;
    const estimate = node.estimateUsd ?? 0;
    if (paidKind && node.estimateUsd === null) {
      set(id, "failed", null, null, "no cost estimate, so the step did not run");
      continue;
    }
    if (spent + estimate > plan.budgetUsd) {
      set(
        id,
        "paused",
        null,
        null,
        `the next step would take spend to $${(spent + estimate).toFixed(4)} of the $${plan.budgetUsd.toFixed(4)} budget; the run stops here`,
      );
      paused = true;
      break;
    }

    set(id, "running", null, null, null);
    try {
      const upstream = new Map(node.dependsOn.map((dep) => [dep, outputs.get(dep) ?? ""]));
      const output = await handler({ node, key, upstream });
      cache.set(key, output);
      outputs.set(id, output.outputHash);
      spent += output.costUsd ?? estimate;
      set(id, "done", output.outputHash, output.costUsd, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "the step failed";
      set(id, "failed", null, null, message.slice(0, REASON_MAX));
    }
  }

  const finished = order.every((id) => states.get(id) === "done" || states.get(id) === "cache_hit");
  const status = paused ? "paused" : finished ? "complete" : "incomplete";
  return { status, spentUsd: spent, outputs };
}

/** A stable hash of a run's outputs, for a test or a log line that says what the run produced. */
export function runFingerprint(outputs: Map<string, string>): string {
  return contentHash([...outputs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
