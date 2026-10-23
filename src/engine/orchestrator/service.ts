// Plans a stored draft: the user's chosen model writes the plan, through the Claude client, on a budget hold of its own. The steps are:
// 1. Every check runs before the plan is claimed, and writes nothing: the brief must match its contract, the chosen model must be a live text
//    model with a per-token price, the workspace month must be below its budget, and the hold must be a valid reservation.
//    A failed check refuses the plan with the reason, and no call is made.
// 2. The plan is claimed for planning in one conditional update, so two requests cannot both call the model. From the claim on, a throw puts
//    the plan back to the status it had.
// 3. The hold is taken on the ledger, under the plan's own request id, and the call (planWithRole) is journaled and budgeted like every role
//    call. Its answer is checked against the live catalog.
// 4. The outcome is stored: ready with the checked plan, or refused with the reasons. A note (an estimate above its line, a plan that asks for
//    more than the user set) is stored with a ready plan, never as a refusal.
//
// A budget is a line (owner direction 2026-10-23, D12, D17). Nothing is committed at planning, so the planning call's hold must fit the user's
// budget, or the draft is refused before any call. The month check reads what the month has committed: the call starts only while that is
// below the month budget.
//
// The catalog, the gateway and the workspace's monthly budget source are passed in. In production the catalog is read through the gateway;
// without a connected key it is NOT_CONNECTED and nothing here is called. Without a known monthly budget, nothing is held.

import { estimateFromPriceUsd } from "../claude/rates.ts";
import { MODEL_BRIEF_PROMPT, ORCHESTRATOR_PLAN_ESTIMATE_TOKENS, orchestratorBriefSchema } from "../claude/roles/orchestrator_plan.ts";
import { loadPrompt } from "../prompts/load.ts";
import { textInputTokensOf, validatePlan } from "./validate.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema, sumUsd, type BudgetReservation } from "../contracts/index.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { positionOfLine, roundUpUsd, startsBelowLine } from "../budget/line.ts";
import { newId } from "../contracts/ids.ts";
import type { RoleDeps } from "../claude/client.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import { sqlRoleCallJournal } from "../jobs/role-call-store.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { OrchestratorPlan } from "./contracts.ts";
import { categoryBudgetsOf } from "./categories.ts";
import { lineOf, planAskNote } from "./envelope.ts";
import { planWithRole, type PlannerBrief } from "./planner.ts";
import { claimForPlanning, getPlan, recordPlanOutcome, releasePlanning, type StoredPlan } from "./store.ts";

export type PlanScope = {
  sql: Sql;
  organizationId: string;
  gateway: Gateway;
  catalog: Map<string, CatalogEntry>;
  /** The model families the workspace has switched off. The catalog above has none of them; a plan naming one is refused with that reason. */
  disabledFamilies?: readonly string[];
  /** When the catalog was read. It is stored with the plan. */
  catalogReadAt: string | null;
  /** The clock, as an ISO time. */
  now: () => string;
  /** Mints the request and reservation ids. Tests pass fixed ids; production passes none. */
  mint?: { request: () => string; reservation: () => string };
  /** The workspace's monthly budget, read from the source the other flows use. Not known: no call is made and nothing is held. */
  workspaceBudget: WorkspaceBudgetSource;
};

export type PlanDraftOutcome =
  | { status: "not_found" }
  | { status: "not_planned"; reasons: string[]; stored: StoredPlan }
  | { status: "ready"; stored: StoredPlan; plan: OrchestratorPlan }
  | { status: "refused"; stored: StoredPlan; reasons: string[] };

type Ledger = ReturnType<typeof scopedLedgerStore>;

/** The ids, the time and the ledger of one planning attempt, minted before any check. */
type Attempt = { requestId: string; reservationId: string; createdAt: string; ledger: Ledger };

/** The checks before the call: the brief and the reservation it can run on, or the reasons it cannot run. */
type Checked = { ok: true; brief: PlannerBrief; reservation: BudgetReservation } | { ok: false; reasons: string[] };

function noCall(reason: string): Checked {
  return { ok: false, reasons: [reason] };
}

function refusal(scope: PlanScope, stored: StoredPlan, reasons: string[]): Promise<PlanDraftOutcome> {
  return recordPlanOutcome(scope.sql, { id: stored.id, organizationId: scope.organizationId, plan: null, reasons, catalogReadAt: scope.catalogReadAt }).then(
    (updated) => ({ status: "refused", stored: updated ?? stored, reasons }),
  );
}

/**
 * Every check before the call. It stores nothing. The hold is the call's estimate, rounded up to four decimals, for the call and its one
 * retry. The hold must fit the user's budget (D17). The month must be below its budget, and the hold must be a valid reservation before
 * anything is written.
 */
async function checkPlanCall(scope: PlanScope, stored: StoredPlan, attempt: Attempt): Promise<Checked> {
  const brief = orchestratorBriefSchema.safeParse(stored.brief);
  if (!brief.success) return noCall("the brief does not match the brief contract, so no call is made");

  const entry = scope.catalog.get(stored.orchestratorModel);
  if (!entry) return noCall(`orchestrator ${stored.orchestratorModel} is not in the live catalog, so no call is made`);
  if (entry.kind !== "text") return noCall(`orchestrator ${stored.orchestratorModel} is a ${entry.kind} model, not a text model, so no call is made`);
  const { promptUsdPerToken, completionUsdPerToken } = entry.pricing;
  if (promptUsdPerToken === null || completionUsdPerToken === null) {
    return noCall(`orchestrator ${stored.orchestratorModel} has no per-token price in the listing, so its call cannot be priced and no call is made`);
  }

  // The client allows one retry of an answer that fails its contract, and the retry is a second paid call. The hold covers both.
  // The plan call's input is the planner's prompt: the brief, and the catalog it is shown. The hold is sized from both (review 2026-10-22, item 2),
  // so a full catalog is not held as if it were the fixed 8000 tokens it once was. The output is the planner's own maximum.
  const inputTokens = planInputTokensOf(scope.catalog, brief.data);
  const estimateUsd = roundUpUsd(estimateFromPriceUsd({ promptUsdPerToken, completionUsdPerToken }, { input: inputTokens, output: ORCHESTRATOR_PLAN_ESTIMATE_TOKENS.output }));
  const redoUsd = estimateUsd;
  const heldUsd = sumUsd([estimateUsd, redoUsd]);

  // The planning call follows the same rule (D17): its hold must fit the budget, or the draft is refused before any call. Nothing is committed
  // at planning, so the spend is zero. The budget is the user's: the plan's own budget is not known until the call answers.
  if (!startsBelowLine(0, stored.budgetUsd) || positionOfLine(heldUsd, stored.budgetUsd) !== "within_budget") {
    return noCall(
      `the plan call's hold of $${heldUsd.toFixed(4)} would take the spend past the $${stored.budgetUsd.toFixed(4)} budget (committed $0.0000), so the draft is refused before any call`,
    );
  }

  // The workspace month: the call starts only while the month's committed spend is below its budget (run-budget.ts uses the same rule).
  const month = await scope.workspaceBudget.monthBudget({ organizationId: scope.organizationId, requestId: attempt.requestId, now: attempt.createdAt });
  if (month.status !== "known") return noCall(month.reason);
  const monthCommittedUsd = await attempt.ledger.committedForMonth(scope.organizationId, attempt.createdAt.slice(0, 7));
  if (!startsBelowLine(monthCommittedUsd, month.usd)) {
    return noCall(
      `workspace monthly budget reached: $${monthCommittedUsd.toFixed(4)} is committed against the $${month.usd.toFixed(4)} budget, so no call is made`,
    );
  }

  // No allowance fields: the request line is the plan's budget, and the month line is the workspace month's budget (contract v11).
  const reservation = budgetReservationSchema.safeParse({
    schema: BUDGET_RESERVATION_SCHEMA,
    reservationId: attempt.reservationId,
    requestId: attempt.requestId,
    workspaceId: scope.organizationId,
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd }],
    estimateUsd,
    redoAllowanceUsd: redoUsd,
    reservedUsd: heldUsd,
    requestBudgetUsd: stored.budgetUsd,
    workspaceMonthBudgetUsd: month.usd,
    state: "reserved",
    createdAt: attempt.createdAt,
  });
  if (!reservation.success) {
    const detail = reservation.error.issues[0]?.message ?? "the amounts are not valid";
    return noCall(`the hold does not match the reservation contract, so no call is made: ${detail}`);
  }
  return { ok: true, brief: { ...brief.data }, reservation: reservation.data };
}

/**
 * The input tokens a plan call may send: the catalog it is shown (about three characters a token), and the brief, never less than the fixed
 * estimate. The bound is the larger of the two, so the hold covers the call that is made.
 */
export function planInputTokensOf(catalog: Map<string, CatalogEntry>, brief: unknown): number {
  const catalogTokens = Math.ceil(JSON.stringify([...catalog.values()]).length / 3);
  // The model brief is sent with every plan call (orchestrator_plan.ts), so its size is part of the hold.
  const briefTokens = Math.ceil(loadPrompt(MODEL_BRIEF_PROMPT).text.length / 3);
  return Math.min(PRICING_LIMIT_INPUT, Math.max(ORCHESTRATOR_PLAN_ESTIMATE_TOKENS.input, catalogTokens + textInputTokensOf(brief) + briefTokens));
}

const PRICING_LIMIT_INPUT = 200_000;

/** The call and what it returns: the hold is written, the model is asked, and its outcome is stored. Runs only while the plan is claimed. */
async function callAndStore(scope: PlanScope, stored: StoredPlan, checked: Extract<Checked, { ok: true }>, attempt: Attempt): Promise<PlanDraftOutcome> {
  const { requestId, reservationId, ledger } = attempt;
  // The engine's reservations belong to a request row (migration 0077). A plan call is a request of its own, with the format orchestrator_plan.
  await scope.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, current_stage, state, pause_reason)
    values (${requestId}, ${scope.organizationId}, 'orchestrator_plan', 'normal', 'running', 'plan', ${JSON.stringify({ kind: "orchestrator_plan", planId: stored.id })}, '')
  `;
  await ledger.createReservation(checked.reservation);

  const deps: RoleDeps = {
    gateway: scope.gateway,
    ledger,
    now: scope.now,
    journal: sqlRoleCallJournal(scope.sql, { organizationId: scope.organizationId, requestId }),
  };
  // The plan's hold is released once the call is over: what was billed is settled on the ledger, and the unused part is given back. A call
  // that was not billed or settled keeps its hold, so money a provider may have charged is never released as if it were free (review 2026-10-22, item 4).
  let outcome: Awaited<ReturnType<typeof planWithRole>>;
  try {
    outcome = await planWithRole({
      deps,
      requestId,
      workspaceId: scope.organizationId,
      reservationId,
      orchestrator: { provider: "openrouter", id: stored.orchestratorModel },
      brief: checked.brief,
      catalog: scope.catalog,
      disabledFamilies: scope.disabledFamilies,
    });
  } finally {
    await releaseReservation(attempt.ledger, reservationId).catch(() => undefined);
  }

  await scope.sql`
    update engine_requests set status = ${outcome.ok ? "delivered" : "rejected"}, current_stage = 'plan', updated_at = now()
    where organization_id = ${scope.organizationId} and id = ${requestId}
  `;
  if (!outcome.ok) return refusal(scope, stored, outcome.reasons);

  // A ready plan is stored with its notes (D17, envelope.ts): an estimate above its line, and a plan that asks for more than the user set. The
  // notes come from the same check the run makes, with the line the run will hold the plan to.
  const noted = validatePlan(outcome.plan, scope.catalog, {
    textInputTokens: textInputTokensOf(stored.brief),
    disabledFamilies: scope.disabledFamilies,
    budgetUsd: lineOf(outcome.plan.budgetUsd, stored.budgetUsd),
    categoryBudgetsUsd: categoryBudgetsOf(checked.brief),
  });
  if (!noted.ok) return refusal(scope, stored, noted.reasons);
  const asked = planAskNote(outcome.plan.budgetUsd, stored.budgetUsd);
  const ready = await recordPlanOutcome(scope.sql, {
    id: stored.id,
    organizationId: scope.organizationId,
    plan: outcome.plan,
    reasons: asked === null ? noted.notes : [asked, ...noted.notes],
    catalogReadAt: scope.catalogReadAt,
  });
  return { status: "ready", stored: ready ?? stored, plan: outcome.plan };
}

export async function planStoredDraft(scope: PlanScope, planId: string): Promise<PlanDraftOutcome> {
  const stored = await getPlan(scope.sql, scope.organizationId, planId);
  if (stored === null) return { status: "not_found" };
  if (stored.status !== "draft" && stored.status !== "refused") {
    return { status: "not_planned", reasons: [`the plan is ${stored.status}; only a draft or a refused plan is planned again`], stored };
  }

  // The checks come before the claim, so nothing is stored for a plan this request does not hold.
  const requestId = scope.mint?.request() ?? newId("req_");
  const reservationId = scope.mint?.reservation() ?? newId("res_");
  const attempt: Attempt = { requestId, reservationId, createdAt: scope.now(), ledger: scopedLedgerStore(scope.sql, scope.organizationId, reservationId) };
  const checked = await checkPlanCall(scope, stored, attempt);

  if (!(await claimForPlanning(scope.sql, scope.organizationId, planId))) {
    const current = (await getPlan(scope.sql, scope.organizationId, planId)) ?? stored;
    return { status: "not_planned", reasons: ["the plan is being planned or changed by another request, so it is not planned again"], stored: current };
  }
  try {
    if (!checked.ok) return await refusal(scope, stored, checked.reasons);
    return await callAndStore(scope, stored, checked, attempt);
  } catch (error) {
    // Planning threw after the claim. The plan goes back to the status it had, so it is never left in planning with nothing running.
    // The original error is the one the caller sees, so a failure to reset is not thrown over it.
    await releasePlanning(scope.sql, scope.organizationId, planId, stored.status).catch(() => undefined);
    throw error;
  }
}
