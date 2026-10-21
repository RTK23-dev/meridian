// Runs a stored plan, and edits one step of it. The plan is checked against the catalog before every run, so a plan can never run on a
// catalogue it was not checked against. Cached step outputs persist between runs, so a re-run after an edit runs only the steps the edit
// touched (dirty.ts). Spend accumulates across runs of one plan, so the plan's budget is a limit on the plan, not on one run.
//
// The handlers are passed in. Without a handler for a kind, its steps report not_connected and nothing is called.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { NodeEvent, OrchestratorPlan } from "./contracts.ts";
import { cacheKeys } from "./dirty.ts";
import { runPlan, type Handlers, type RunCache } from "./execute.ts";
import { editNode, type NodeChange } from "./stale.ts";
import { appendPlanEvents, getPlan, listStepOutputs, putStepOutput, setPlanStatus, updatePlanJson } from "./store.ts";
import { validatePlan } from "./validate.ts";

export type RunOutcome =
  | { status: "not_found" }
  | { status: "not_runnable"; reasons: string[] }
  | { status: "complete" | "paused" | "incomplete"; spentUsd: number; events: NodeEvent[] };

export async function runStoredPlan(
  sql: Sql,
  opts: { organizationId: string; planId: string; catalog: Map<string, CatalogEntry>; handlers: Handlers },
): Promise<RunOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.plan === null) return { status: "not_runnable", reasons: ["the plan has no checked plan to run: it is a draft or was refused"] };
  if (stored.status === "running") return { status: "not_runnable", reasons: ["the plan is already running"] };

  const checked = validatePlan(stored.plan, opts.catalog);
  if (!checked.ok) return { status: "not_runnable", reasons: checked.reasons };

  await setPlanStatus(sql, opts.organizationId, opts.planId, "running");
  const persisted = await listStepOutputs(sql, opts.organizationId, opts.planId);
  const keys = cacheKeys(checked.plan, checked.order);

  // What the plan has spent so far: each step whose current output is stored is charged its actual cost, or its estimate when none was reported.
  let spentSoFar = 0;
  const byId = new Map(checked.plan.nodes.map((node) => [node.id, node]));
  for (const id of checked.order) {
    const output = persisted.get(keys.get(id) ?? "");
    if (output === undefined) continue;
    spentSoFar += output.costUsd ?? byId.get(id)?.estimateUsd ?? 0;
  }

  const cache: RunCache = new Map(persisted);
  const before = new Set(cache.keys());
  const events: NodeEvent[] = [];
  const result = await runPlan({
    plan: checked.plan,
    order: checked.order,
    handlers: opts.handlers,
    cache,
    spentUsd: spentSoFar,
    emit: (event) => events.push(event),
  });

  for (const [key, output] of cache) {
    if (!before.has(key)) await putStepOutput(sql, opts.organizationId, opts.planId, key, output);
  }
  await appendPlanEvents(sql, opts.organizationId, opts.planId, events);
  await setPlanStatus(sql, opts.organizationId, opts.planId, result.status === "complete" ? "complete" : result.status === "paused" ? "paused" : "incomplete");
  return { status: result.status, spentUsd: result.spentUsd, events };
}

export type EditOutcome =
  | { status: "not_found" }
  | { status: "refused"; reasons: string[] }
  | { status: "edited"; plan: OrchestratorPlan };

/**
 * Change one step of a stored plan. The change is applied to a copy, the copy is checked against the catalog, and only a plan that passes
 * replaces the stored one. A refused edit changes nothing.
 */
export async function editStoredPlan(
  sql: Sql,
  opts: { organizationId: string; planId: string; catalog: Map<string, CatalogEntry>; nodeId: string; change: NodeChange },
): Promise<EditOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.plan === null) return { status: "refused", reasons: ["the plan has no checked plan to edit"] };
  if (stored.status === "running") return { status: "refused", reasons: ["the plan is running, so it cannot be edited until the run stops"] };

  let next: OrchestratorPlan;
  try {
    next = editNode(stored.plan, opts.nodeId, opts.change);
  } catch (error) {
    return { status: "refused", reasons: [error instanceof Error ? error.message : "the edit could not be applied"] };
  }
  const checked = validatePlan(next, opts.catalog);
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  await updatePlanJson(sql, opts.organizationId, opts.planId, checked.plan);
  return { status: "edited", plan: checked.plan };
}
