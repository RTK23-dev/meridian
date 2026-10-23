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
import { allowanceUsd, roundUpUsd } from "../budget/tolerance.ts";
import type { BudgetEnvelope } from "./envelope.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";

export type RunBudget = {
  ledger: ReturnType<typeof scopedLedgerStore>;
  reservationId: string;
  requestId: string;
};

export type OpenRunBudget = { status: "open"; budget: RunBudget } | { status: "refused"; reasons: string[] };

/**
 * Take the run's reservation for what the plan may still spend: its envelope's allowance (the budget plus its tolerance, envelope.ts) less
 * what earlier runs spent. Refused, with the reasons, when that is used up, or when the workspace month cannot cover it past its own tolerance.
 * A refused run is not started: it waits for an approval, which raises the budget. Money is in USD, to four decimals.
 */
export async function openRunBudget(
  sql: Sql,
  opts: {
    organizationId: string;
    planId: string;
    envelope: BudgetEnvelope;
    spentUsd: number;
    workspaceBudget: WorkspaceBudgetSource;
    now: () => string;
  },
): Promise<OpenRunBudget> {
  const remaining = roundUpUsd(opts.envelope.allowanceUsd - opts.spentUsd);
  if (remaining <= 0) {
    return {
      status: "refused",
      reasons: [
        `the plan has spent $${opts.spentUsd.toFixed(4)} of its $${opts.envelope.allowanceUsd.toFixed(4)} allowance (the budget plus its tolerance), so no paid step can run until the budget is raised`,
      ],
    };
  }

  const requestId = newId("req_");
  const reservationId = newId("res_");
  const createdAt = opts.now();
  const month = await opts.workspaceBudget.monthBudget({ organizationId: opts.organizationId, requestId, now: createdAt });
  if (month.status !== "known") return { status: "refused", reasons: [month.reason] };
  const monthAllowance = allowanceUsd(month.usd, month.tolerance ?? opts.envelope.tolerance);

  const ledger = scopedLedgerStore(sql, opts.organizationId, reservationId);
  const totals = await ledger.sumForMonth(opts.organizationId, createdAt.slice(0, 7));
  const committedUsd = sumUsd([totals.reservedUsd, remaining]);
  if (committedUsd > monthAllowance) {
    return {
      status: "refused",
      reasons: [`workspace monthly budget ${month.usd} USD (allowance ${monthAllowance} USD, the budget plus its tolerance) would be exceeded: ${committedUsd} USD committed`],
    };
  }

  // The run's own limits are what it may still spend. That amount already includes the tolerance, so the run's request budget and its
  // allowance are the same figure: a call past it is refused in cap mode (budget/reserve.ts).
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
    requestBudgetUsd: remaining,
    requestAllowanceUsd: remaining,
    workspaceMonthBudgetUsd: month.usd,
    workspaceMonthAllowanceUsd: monthAllowance,
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
