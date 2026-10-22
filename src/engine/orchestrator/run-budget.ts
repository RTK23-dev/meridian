// A run's budget (Bible 14.1, budget/reserve.ts and budget/reconcile.ts). A run takes one reservation for the money the plan may still
// spend, under a request row of its own (format orchestrator_run). Each paid step's call is authorized against that reservation and
// settled to its bill. When the run stops, the unspent part is released, so the workspace month gets it back.
//
// The reservation is the run's hard limit. A call that would take the run past it is refused before it is made, and a run whose
// remaining budget does not fit the workspace month is refused before it starts. Nothing here calls a provider.

import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema, sumUsd } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";

export type RunBudget = {
  ledger: ReturnType<typeof scopedLedgerStore>;
  reservationId: string;
  requestId: string;
};

export type OpenRunBudget = { status: "open"; budget: RunBudget } | { status: "refused"; reasons: string[] };

/** Up to four decimals, rounded up: the hold is never smaller than what the run may spend. */
function roundUpUsd(value: number): number {
  return Math.ceil(value * 10000 - 1e-6) / 10000;
}

/**
 * Take the run's reservation for what the plan has not yet spent. Refused, with the reasons, when nothing is left to spend, when the
 * workspace month cannot cover it, or when the reservation does not match its contract. A refused run is not started.
 */
export async function openRunBudget(
  sql: Sql,
  opts: {
    organizationId: string;
    planId: string;
    planBudgetUsd: number;
    requestBudgetUsd: number;
    spentUsd: number;
    workspaceBudget: WorkspaceBudgetSource;
    now: () => string;
  },
): Promise<OpenRunBudget> {
  const remaining = roundUpUsd(opts.planBudgetUsd - opts.spentUsd);
  if (remaining <= 0) {
    return {
      status: "refused",
      reasons: [`the plan has spent $${opts.spentUsd.toFixed(4)} of its $${opts.planBudgetUsd.toFixed(4)} budget, so no paid step can run; raise the budget to run it again`],
    };
  }

  const requestId = newId("req_");
  const reservationId = newId("res_");
  const createdAt = opts.now();
  const month = await opts.workspaceBudget.monthBudget({ organizationId: opts.organizationId, requestId, now: createdAt });
  if (month.status !== "known") return { status: "refused", reasons: [month.reason] };

  const ledger = scopedLedgerStore(sql, opts.organizationId, reservationId);
  const totals = await ledger.sumForMonth(opts.organizationId, createdAt.slice(0, 7));
  const committedUsd = sumUsd([totals.reservedUsd, remaining]);
  if (committedUsd > month.usd) {
    return { status: "refused", reasons: [`workspace monthly budget ${month.usd} USD would be exceeded: ${committedUsd} USD committed`] };
  }

  const reservation = budgetReservationSchema.safeParse({
    schema: BUDGET_RESERVATION_SCHEMA,
    reservationId,
    requestId,
    workspaceId: opts.organizationId,
    mode: "cap",
    lines: [{ stage: "orchestrator_run", estimateUsd: remaining }],
    estimateUsd: remaining,
    redoAllowanceUsd: 0,
    reservedUsd: remaining,
    requestBudgetUsd: opts.requestBudgetUsd,
    workspaceMonthBudgetUsd: month.usd,
    state: "reserved",
    createdAt,
  });
  if (!reservation.success) {
    const detail = reservation.error.issues[0]?.message ?? "the amounts are not valid";
    return { status: "refused", reasons: [`the run's hold does not match the reservation contract, so the run is not started: ${detail}`] };
  }

  await sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, current_stage, state, pause_reason)
    values (${requestId}, ${opts.organizationId}, 'orchestrator_run', 'normal', 'running', 'run', ${JSON.stringify({ kind: "orchestrator_run", planId: opts.planId })}, '')
  `;
  await ledger.createReservation(reservation.data);
  return { status: "open", budget: { ledger, reservationId, requestId } };
}

/**
 * Release the unspent part of the run's reservation and record how the request ended. Calls still held keep their holds, so a held call
 * is never released as if it were free. Releasing twice changes nothing.
 */
export async function releaseRunBudget(sql: Sql, opts: { organizationId: string; budget: RunBudget; requestStatus: "delivered" | "paused" | "rejected" }): Promise<void> {
  await releaseReservation(opts.budget.ledger, opts.budget.reservationId);
  await sql`
    update engine_requests set status = ${opts.requestStatus}, current_stage = 'run', updated_at = now()
    where organization_id = ${opts.organizationId} and id = ${opts.budget.requestId}
  `;
}
