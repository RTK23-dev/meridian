// A run's budget (Bible 14.1, budget/reserve.ts and budget/reconcile.ts). A run takes one reservation for the money its line leaves, under a
// request row of its own (format orchestrator_run). Each paid step's call is authorized against that reservation and settled to its bill.
// When the run stops, the unspent part is released, so the workspace month gets it back.
//
// A budget is a line (owner direction 2026-10-23, decision D12). The reservation's request budget is what the run may still spend: the
// line less what is committed before the run, so a call starts only while the run's committed spend is below it. The run opens only while
// its workspace month's committed spend is below the month budget. A call that starts may take the run past the line; the overshoot is
// recorded. Nothing here calls a provider.

import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { roundUpUsd, startsBelowLine } from "../budget/line.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";

export type RunBudget = {
  ledger: ReturnType<typeof scopedLedgerStore>;
  reservationId: string;
  requestId: string;
};

export type OpenRunBudget = { status: "open"; budget: RunBudget } | { status: "refused"; reasons: string[] };

/**
 * Take the run's reservation for what the plan may still spend: its line less what is committed before the run. Refused, with the reasons,
 * when the line is already reached, or when the workspace month is at its own budget. A refused run is not started: it waits for an
 * approval, which raises the budget. Money is in USD, to four decimals.
 */
export async function openRunBudget(
  sql: Sql,
  opts: {
    organizationId: string;
    planId: string;
    /** The run's line: the lower of the plan's budget and the budget the user set (envelope.ts lineOf). */
    lineUsd: number;
    /** What is committed before the run: the stored outputs, the failed holds and the waiting holds (run.ts). */
    spentUsd: number;
    workspaceBudget: WorkspaceBudgetSource;
    now: () => string;
  },
): Promise<OpenRunBudget> {
  if (!startsBelowLine(opts.spentUsd, opts.lineUsd)) {
    return {
      status: "refused",
      reasons: [
        `the plan has committed $${opts.spentUsd.toFixed(4)} against its $${opts.lineUsd.toFixed(4)} budget, so no paid step can run until the budget is raised`,
      ],
    };
  }
  const remaining = roundUpUsd(opts.lineUsd - opts.spentUsd);

  const requestId = newId("req_");
  const reservationId = newId("res_");
  const createdAt = opts.now();
  const month = await opts.workspaceBudget.monthBudget({ organizationId: opts.organizationId, requestId, now: createdAt });
  if (month.status !== "known") return { status: "refused", reasons: [month.reason] };

  // The run opens while its month's committed spend is below the month budget. Each call is then checked against the month line (authorizeCall).
  const ledger = scopedLedgerStore(sql, opts.organizationId, reservationId);
  const monthCommittedUsd = await ledger.committedForMonth(opts.organizationId, createdAt.slice(0, 7));
  if (!startsBelowLine(monthCommittedUsd, month.usd)) {
    return {
      status: "refused",
      reasons: [
        `workspace monthly budget reached: $${monthCommittedUsd.toFixed(4)} is committed against the $${month.usd.toFixed(4)} budget, so the run is not started`,
      ],
    };
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
    requestBudgetUsd: remaining,
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
