// Plans a stored draft: the user's chosen model writes the plan, through the Claude client, on a budget hold of its own. The steps are:
// 1. Every check runs before the plan is claimed, and writes nothing: the brief must match its contract, the chosen model must be a live text
//    model with a per-token price, the hold must fit the plan's budget and the workspace month, and the hold must be a valid reservation.
//    A failed check refuses the plan with the reason, and no call is made.
// 2. The plan is claimed for planning in one conditional update, so two requests cannot both call the model. From the claim on, a throw puts
//    the plan back to the status it had.
// 3. The hold is taken on the ledger, under the plan's own request id, and the call (planWithRole) is journaled and budgeted like every role
//    call. Its answer is checked against the live catalog, and its budget against the budget the user set.
// 4. The outcome is stored: ready with the checked plan, or refused with the reasons.
//
// The catalog, the gateway and the workspace's monthly budget source are passed in. In production the catalog is read through the gateway;
// without a connected key it is NOT_CONNECTED and nothing here is called. Without a known monthly budget, nothing is held.

import { estimateFromPriceUsd } from "../claude/rates.ts";
import { ORCHESTRATOR_PLAN_ESTIMATE_TOKENS, orchestratorBriefSchema } from "../claude/roles/orchestrator_plan.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema, sumUsd, type BudgetReservation } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import type { RoleDeps } from "../claude/client.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import { sqlRoleCallJournal } from "../jobs/role-call-store.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { OrchestratorPlan } from "./contracts.ts";
import { planWithRole, type PlannerBrief } from "./planner.ts";
import { claimForPlanning, getPlan, recordPlanOutcome, releasePlanning, type StoredPlan } from "./store.ts";
import { planBudgetReason } from "./validate.ts";

export type PlanScope = {
  sql: Sql;
  organizationId: string;
  gateway: Gateway;
  catalog: Map<string, CatalogEntry>;
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

/** Rounds a computed USD amount up to four decimals, the precision a reservation carries (contracts/money.ts). */
function roundUpUsd(value: number): number {
  return Math.ceil(value * 10000) / 10000;
}

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
 * retry. It must fit the plan's budget and the workspace month (the month's reserved total plus this hold, as reserve() checks it), and it
 * must be a valid reservation before anything is written.
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
  const estimateUsd = roundUpUsd(estimateFromPriceUsd({ promptUsdPerToken, completionUsdPerToken }, ORCHESTRATOR_PLAN_ESTIMATE_TOKENS));
  const redoUsd = estimateUsd;
  const heldUsd = sumUsd([estimateUsd, redoUsd]);
  if (heldUsd > stored.budgetUsd) {
    return noCall(`the plan call and its one retry are estimated at $${heldUsd.toFixed(4)}, over the plan's $${stored.budgetUsd.toFixed(4)} budget, so no call is made`);
  }

  const month = await scope.workspaceBudget.monthBudget({ organizationId: scope.organizationId, requestId: attempt.requestId, now: attempt.createdAt });
  if (month.status !== "known") return noCall(month.reason);
  const totals = await attempt.ledger.sumForMonth(scope.organizationId, attempt.createdAt.slice(0, 7));
  const committedUsd = sumUsd([totals.reservedUsd, heldUsd]);
  const reasons: string[] = [];
  if (committedUsd > month.usd) {
    reasons.push(`workspace monthly budget ${month.usd} USD would be exceeded: ${committedUsd} USD committed`);
  }

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
    return { ok: false, reasons: [...reasons, `the hold does not match the reservation contract, so no call is made: ${detail}`] };
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, brief: { ...brief.data }, reservation: reservation.data };
}

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
  const outcome = await planWithRole({
    deps,
    requestId,
    workspaceId: scope.organizationId,
    reservationId,
    orchestrator: { provider: "openrouter", id: stored.orchestratorModel },
    brief: checked.brief,
    catalog: scope.catalog,
  });

  await scope.sql`
    update engine_requests set status = ${outcome.ok ? "delivered" : "rejected"}, current_stage = 'plan', updated_at = now()
    where organization_id = ${scope.organizationId} and id = ${requestId}
  `;
  if (!outcome.ok) return refusal(scope, stored, outcome.reasons);
  // The model wrote the plan's budget, and the run is capped by it. A plan that asks for more than the user set is refused, not stored as ready.
  const overBudget = planBudgetReason(outcome.plan.budgetUsd, stored.budgetUsd);
  if (overBudget !== null) return refusal(scope, stored, [overBudget]);

  const ready = await recordPlanOutcome(scope.sql, {
    id: stored.id,
    organizationId: scope.organizationId,
    plan: outcome.plan,
    reasons: [],
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
