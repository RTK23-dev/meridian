// Runs a stored plan, and edits one step of it. The plan is checked against the catalog before every run, so a plan can never run on a
// catalogue it was not checked against. Cached step outputs persist between runs, so a re-run after an edit runs only the steps the edit
// touched (dirty.ts). Money accumulates across runs of one plan, and a budget is a line (owner direction 2026-10-23, D12):
// - the line is the lower of the plan's budget and the budget the user set (envelope.ts lineOf). A brief's category budgets are lines too.
// - the committed spend at the start of a run is the stored outputs' costs, the failed holds, and the holds of the jobs still waiting at
//   their providers (D14). A waiting job with no recorded hold refuses the run until the poll settles it.
// - a run whose spend is already at the line opens no reservation: it pauses at its first paid step.
// - otherwise the run takes a reservation for what the line leaves (run-budget.ts), and its handlers are made from it.
//
// The handlers are passed in. Without a handler for a kind, its steps report not_connected and nothing is called. Measure mode (D15) is
// passed to the validation, the executor and the handlers; it is off unless the caller passes it.

import { sumUsd } from "../contracts/index.ts";
import { startsBelowLine } from "../budget/line.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { NodeEvent, OrchestratorPlan } from "./contracts.ts";
import { runPlan, type Handlers, type RunCache } from "./execute.ts";
import { openRunBudget, releaseRunBudget, type RunBudget } from "./run-budget.ts";
import { lineOf } from "./envelope.ts";
import { editNode, type NodeChange } from "./stale.ts";
import { waitingHoldsByNode } from "./holds.ts";
import type { MeasureOptions } from "./measure.ts";
import {
  appendPlanEvents,
  failedHoldsByNode,
  getPlan,
  listStepOutputs,
  outputsSpentByCategory,
  putStepOutput,
  setPlanStatus,
  updatePlanJson,
} from "./store.ts";
import { textInputTokensOf, validatePlan } from "./validate.ts";
import { categoryBudgetsOf, categoryOf, categorySpentOf, type BudgetCategory } from "./categories.ts";
import { cacheKeys } from "./dirty.ts";
import { orchestratorBriefSchema } from "../claude/roles/orchestrator_plan.ts";

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
  /**
   * The handlers of the run. With the run's reservation they are made from it. With null the line is reached before the run: no reservation
   * is opened, and the executor pauses at the run's first paid step before any paid call is made.
   */
  handlersFor: (budget: RunBudget | null, measure: MeasureOptions | null) => Handlers;
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

/** The holds of failed and waiting paid steps, summed by step. Both take their step's category (categories.ts). */
function mergeHolds(failed: Map<string, number>, waiting: Map<string, number>): Map<string, number> {
  const merged = new Map(failed);
  for (const [nodeId, usd] of waiting) merged.set(nodeId, sumUsd([merged.get(nodeId) ?? 0, usd]));
  return merged;
}

export async function runStoredPlan(
  sql: Sql,
  opts: {
    organizationId: string;
    planId: string;
    catalog: Map<string, CatalogEntry>;
    disabledFamilies?: readonly string[];
    handlers?: Handlers;
    budget?: RunBudgetSource;
    /** Measure mode (D15): a video or avatar step with no engine price may run, held to the ceiling times its length. Absent or null: off. */
    measure?: MeasureOptions | null;
  },
): Promise<RunOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.plan === null) return { status: "not_runnable", reasons: ["the plan has no checked plan to run: it is a draft or was refused"] };
  if (stored.status === "running") return { status: "not_runnable", reasons: ["the plan is already running"] };

  // The line (D12): the lower of the plan's budget and the budget the user set. A plan that asks for more than the user set is held to the
  // user's budget: a note at planning, never a refusal here.
  const line = lineOf(stored.plan.budgetUsd, stored.budgetUsd);
  // The brief's category budgets are lines too (categories.ts). A brief that does not match its contract gives no lines to check against, so the run is refused.
  const brief = orchestratorBriefSchema.safeParse(stored.brief);
  if (!brief.success) return { status: "not_runnable", reasons: ["the brief does not match the brief contract, so the plan cannot run"] };
  const categoryLines = categoryBudgetsOf(brief.data);
  const measure = opts.measure ?? null;
  const checked = validatePlan(stored.plan, opts.catalog, {
    textInputTokens: textInputTokensOf(stored.brief),
    disabledFamilies: opts.disabledFamilies,
    budgetUsd: line,
    categoryBudgetsUsd: categoryLines,
    measure,
  });
  if (!checked.ok) return { status: "not_runnable", reasons: checked.reasons };
  if (!(await claimRun(sql, opts.organizationId, opts.planId))) return { status: "not_runnable", reasons: ["the plan is already running"] };

  // From the claim until the final status is stored, the plan is running. A failure in between puts it back to ready, which is correct:
  // the plan has a checked plan. The original error is what the caller sees, so a failure to reset is not thrown over it.
  let settled = false;
  let budget: RunBudget | null = null;
  let released = false;
  try {
    const persisted = await listStepOutputs(sql, opts.organizationId, opts.planId);

    // What the plan has committed so far (D12, D14): every stored output of the plan, including outputs of steps an edit has since changed,
    // the holds of paid steps that failed, and the holds of the jobs still waiting at their providers. Money spent on an earlier version of a
    // step is still spent, and a waiting job's hold is counted until its poll settles it. A waiting job with no recorded hold is unknown money,
    // so the run is refused until the poll settles it: unknown is never zero.
    const waiting = await waitingHoldsByNode(sql, opts.organizationId, opts.planId);
    if (waiting.unrecorded.length > 0) {
      return {
        status: "not_runnable",
        reasons: [`a queued job has no recorded hold, so the run cannot count its money; the poll settles it first. Steps: ${waiting.unrecorded.join(", ")}.`],
      };
    }
    const failedByNode = await failedHoldsByNode(sql, opts.organizationId, opts.planId);
    const holdsByNode = mergeHolds(failedByNode, waiting.byNode);
    const spentSoFar = sumUsd([
      ...[...persisted.values()].map((output) => output.costUsd ?? 0),
      ...[...failedByNode.values()],
      ...[...waiting.byNode.values()],
    ]);
    // Each category's spend so far, by the same rule: the stored outputs of the category, and the failed and waiting holds of its steps.
    const outputsByCategory = await outputsSpentByCategory(sql, opts.organizationId, opts.planId);
    const categorySpentSoFar = categorySpentOf(checked.plan.nodes, outputsByCategory, holdsByNode);

    let handlers: Handlers = opts.handlers ?? {};
    if (opts.budget !== undefined) {
      // A run whose line is already reached opens no reservation (D12): its handlers are made without one, and it pauses at its first paid step.
      if (startsBelowLine(spentSoFar, line)) {
        const opened = await openRunBudget(sql, {
          organizationId: opts.organizationId,
          planId: opts.planId,
          lineUsd: line,
          spentUsd: spentSoFar,
          workspaceBudget: opts.budget.workspaceBudget,
          now: opts.budget.now,
        });
        if (opened.status === "refused") return { status: "not_runnable", reasons: opened.reasons };
        budget = opened.budget;
      }
      handlers = opts.budget.handlersFor(budget, measure);
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
      lineUsd: line,
      categoryLinesUsd: categoryLines,
      categorySpentUsd: categorySpentSoFar,
      queued: new Set(waiting.byNode.keys()),
      measure,
      emit: (event) => events.push(event),
    });

    // A new output keeps the category of its step, so a later run totals each category from the stored outputs.
    const keys = cacheKeys(checked.plan, checked.order);
    const categoryOfKey = new Map<string, BudgetCategory | null>();
    for (const node of checked.plan.nodes) {
      const key = keys.get(node.id);
      if (key !== undefined) categoryOfKey.set(key, categoryOf(node.kind));
    }
    for (const [key, output] of cache) {
      if (!before.has(key)) {
        await putStepOutput(sql, opts.organizationId, opts.planId, key, {
          outputHash: output.outputHash,
          costUsd: output.costUsd,
          body: output.body ?? null,
          category: categoryOfKey.get(key) ?? null,
        });
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
