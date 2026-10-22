// Runs a validated plan one step at a time, in order, and reports each step as it changes. Fail closed:
// - a step with no handler for its kind is `not_connected`: it does not run and returns no output;
// - a step whose handler throws is `failed`, and every step that reads it is `skipped`;
// - a step whose estimate would take the run past the budget is never started: the run `paused` there and nothing else runs.
// Cache hits are reported as `cache_hit` and cost nothing. The handlers are injected, so this file calls no provider.

import { contentHash } from "../contracts/hash.ts";
import type { NodeEvent, NodeKind, NodeState, OrchestratorPlan, PlanNode } from "./contracts.ts";
import { cacheKeys } from "./dirty.ts";
import { KIND_CATALOG } from "./validate.ts";

/**
 * What a step produced. `outputHash` identifies it; `body` is its text content (a script, an analysis, a reference's text), or null for a
 * step with no text. A downstream step is given the body of each step it reads, never the hash.
 */
export type NodeOutput = { outputHash: string; costUsd: number | null; body?: string | null };

/**
 * Thrown by a handler whose provider is not connected, before any call is made and before any money is held. The step reports
 * not_connected and nothing is charged. Any other error is a failure, and a paid step's estimate is held for it.
 */
export class NotConnectedError extends Error {
  constructor(reason: string) {
    super(reason.slice(0, REASON_MAX));
    this.name = "NotConnectedError";
  }
}

/**
 * Thrown by a handler that stopped before any call was made, or before a call was authorized: a refused budget, a call already made, a
 * missing model or upstream body. The step fails, and nothing is held, because no money was committed by it.
 */
export class CallRefusedError extends Error {
  constructor(reason: string) {
    super(reason.slice(0, REASON_MAX));
    this.name = "CallRefusedError";
  }
}

/** `upstream` maps each step the handler reads to its body. A null body means no content was stored: the handler must fail closed. */
export type NodeHandler = (input: { node: PlanNode; key: string; upstream: Map<string, string | null> }) => Promise<NodeOutput>;

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
  const bodies = new Map<string, string | null>();
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
      bodies.set(id, hit.body ?? null);
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
      const upstream = new Map(node.dependsOn.map((dep) => [dep, bodies.get(dep) ?? null]));
      const output = await handler({ node, key, upstream });
      // A handler's reported cost is data: it must be a finite number, not negative. Null means no actual cost was reported, so the estimate is
      // charged. Anything else fails the step, and nothing is added to the spend or kept as output.
      const reported = output.costUsd ?? null;
      if (reported !== null && !(Number.isFinite(reported) && reported >= 0)) {
        set(id, "failed", null, null, "the step reported an unusable cost");
        continue;
      }
      // A paid step keeps its charged cost on the stored output, so a later run can total the plan's spend from its stored outputs alone.
      const charged = paidKind ? (reported ?? estimate) : reported;
      const body = output.body ?? null;
      cache.set(key, { outputHash: output.outputHash, costUsd: charged, body });
      outputs.set(id, output.outputHash);
      bodies.set(id, body);
      spent += charged ?? 0;
      set(id, "done", output.outputHash, charged, null);
    } catch (error) {
      // No provider is connected: the handler stopped before any call, so nothing is held and nothing is kept.
      if (error instanceof NotConnectedError) {
        set(id, "not_connected", null, null, error.message);
        continue;
      }
      // A refusal before any call: the step fails, and no estimate is held, because nothing was committed.
      if (error instanceof CallRefusedError) {
        set(id, "failed", null, null, error.message);
        continue;
      }
      // A paid step's estimate is held even though its call threw: the provider may have billed the call before the error. The held amount
      // is recorded on the failed event, so a later run counts it in the plan's spend.
      const held = paidKind ? estimate : null;
      if (held !== null) spent += held;
      const message = error instanceof Error ? error.message : "the step failed";
      set(id, "failed", null, held, message.slice(0, REASON_MAX));
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
