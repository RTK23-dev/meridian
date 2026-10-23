// Runs a stored plan, and edits one step of it. The plan is checked against the catalog before every run, so a plan can never run on a
// catalogue it was not checked against. Cached step outputs persist between runs, so a re-run after an edit runs only the steps the edit
// touched (dirty.ts). Spend accumulates across runs of one plan, so the plan's budget is a limit on the plan, not on one run.
//
// The handlers are passed in. Without a handler for a kind, its steps report not_connected and nothing is called. With a budget, the run
// takes a reservation for what the plan may still spend, and its handlers are made from that reservation (run-budget.ts).

import { sumUsd } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { NodeEvent, OrchestratorPlan } from "./contracts.ts";
import { runPlan, type Handlers, type RunCache } from "./execute.ts";
import { openRunBudget, releaseRunBudget, type RunBudget } from "./run-budget.ts";
import { editNode, type NodeChange } from "./stale.ts";
import { appendPlanEvents, failedHoldsUsd, getPlan, listStepOutputs, putStepOutput, setPlanStatus, updatePlanJson } from "./store.ts";
import { planBudgetReason, textInputTokensOf, validatePlan } from "./validate.ts";

export type RunOutcome =
  | { status: "not_found" }
  | { status: "not_runnable"; reasons: string[] }
  | { status: "complete" | "paused" | "incomplete"; spentUsd: number; events: NodeEvent[] };

/**
 * The run's money. With it, the run takes a budget reservation (run-budget.ts) and its handlers are made from that reservation, so every
 * paid call is authorized against it. Without it, the run takes no reservation and calls the handlers it is given.
 */
export type RunBudgetSource = {
  workspaceBudget: WorkspaceBudgetSource;
  now: () => string;
  handlersFor: (budget: RunBudget) => Handlers;
};

/** The run's claim: one conditional update, so two runs of one plan cannot both start. True only for the call that took the plan. */
async function claimRun(sql: Sql, organizationId: string, planId: string): Promise<boolean> {
  const rows = (await sql`
    update orchestrator_plans set status = 'running', updated_at = now()
    where id = ${planId} and organization_id = ${organizationId} and status <> 'running'
    returning id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

export async function runStoredPlan(
  sql: Sql,
  opts: { organizationId: string; planId: string; catalog: Map<string, CatalogEntry>; disabledFamilies?: readonly string[]; handlers?: Handlers; budget?: RunBudgetSource },
): Promise<RunOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.plan === null) return { status: "not_runnable", reasons: ["the plan has no checked plan to run: it is a draft or was refused"] };
  if (stored.status === "running") return { status: "not_runnable", reasons: ["the plan is already running"] };

  // A second guard: the plan's budget is the one the model wrote, so it must not be above the budget the user set (service.ts refuses it when it is written).
  const overBudget = planBudgetReason(stored.plan.budgetUsd, stored.budgetUsd);
  if (overBudget !== null) return { status: "not_runnable", reasons: [overBudget] };

  const checked = validatePlan(stored.plan, opts.catalog, { textInputTokens: textInputTokensOf(stored.brief), disabledFamilies: opts.disabledFamilies });
  if (!checked.ok) return { status: "not_runnable", reasons: checked.reasons };
  if (!(await claimRun(sql, opts.organizationId, opts.planId))) return { status: "not_runnable", reasons: ["the plan is already running"] };

  // From the claim until the final status is stored, the plan is running. A failure in between puts it back to ready, which is correct:
  // the plan has a checked plan. The original error is what the caller sees, so a failure to reset is not thrown over it.
  let settled = false;
  let budget: RunBudget | null = null;
  let released = false;
  try {
    const persisted = await listStepOutputs(sql, opts.organizationId, opts.planId);

    // What the plan has spent so far: every stored output of the plan, including outputs of steps an edit has since changed, and the holds
    // of paid steps that failed. Money spent on an earlier version of a step is still spent, so the budget counts it. A paid output carries
    // its charged cost (execute.ts).
    const spentSoFar = sumUsd([...[...persisted.values()].map((output) => output.costUsd ?? 0), await failedHoldsUsd(sql, opts.organizationId, opts.planId)]);

    let handlers: Handlers = opts.handlers ?? {};
    if (opts.budget !== undefined) {
      const opened = await openRunBudget(sql, {
        organizationId: opts.organizationId,
        planId: opts.planId,
        planBudgetUsd: checked.plan.budgetUsd,
        requestBudgetUsd: stored.budgetUsd,
        spentUsd: spentSoFar,
        workspaceBudget: opts.budget.workspaceBudget,
        now: opts.budget.now,
      });
      if (opened.status === "refused") return { status: "not_runnable", reasons: opened.reasons };
      budget = opened.budget;
      handlers = opts.budget.handlersFor(opened.budget);
    }

    const cache: RunCache = new Map(persisted);
    const before = new Set(cache.keys());
    const events: NodeEvent[] = [];
    const result = await runPlan({
      plan: checked.plan,
      order: checked.order,
      handlers,
      cache,
      spentUsd: spentSoFar,
      emit: (event) => events.push(event),
    });

    for (const [key, output] of cache) {
      if (!before.has(key)) {
        await putStepOutput(sql, opts.organizationId, opts.planId, key, { outputHash: output.outputHash, costUsd: output.costUsd, body: output.body ?? null });
      }
    }
    await appendPlanEvents(sql, opts.organizationId, opts.planId, events);

    const runStatus = result.status === "complete" ? "complete" : result.status === "paused" ? "paused" : "incomplete";
    if (budget !== null) {
      // The unspent part is released before the plan's status is stored, so a plan that reads as finished has given its budget back.
      released = true;
      await releaseRunBudget(sql, {
        organizationId: opts.organizationId,
        budget,
        requestStatus: runStatus === "complete" ? "delivered" : runStatus === "paused" ? "paused" : "rejected",
      });
    }
    await setPlanStatus(sql, opts.organizationId, opts.planId, runStatus);
    settled = true;
    return { status: result.status, spentUsd: result.spentUsd, events };
  } finally {
    if (!settled) {
      // Nothing more will be called once the run stops, so an open reservation is released even on the failure path.
      if (budget !== null && !released) {
        released = true;
        await releaseRunBudget(sql, { organizationId: opts.organizationId, budget, requestStatus: "rejected" }).catch(() => undefined);
      }
      await setPlanStatus(sql, opts.organizationId, opts.planId, "ready").catch(() => undefined);
    }
  }
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
  opts: { organizationId: string; planId: string; catalog: Map<string, CatalogEntry>; disabledFamilies?: readonly string[]; nodeId: string; change: NodeChange },
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
  const checked = validatePlan(next, opts.catalog, { textInputTokens: textInputTokensOf(stored.brief), disabledFamilies: opts.disabledFamilies });
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  // The write is refused by the store when a run has started since the read above, so an edit never clears a run in progress.
  const saved = await updatePlanJson(sql, opts.organizationId, opts.planId, checked.plan);
  if (saved === null) return { status: "refused", reasons: ["the plan is running, so it cannot be edited until the run stops; nothing was changed"] };
  return { status: "edited", plan: checked.plan };
}
