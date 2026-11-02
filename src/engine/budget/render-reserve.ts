// The hold for one repurposed cut's render (Bible 14). It is checked the way the intake hold is: against the request's budget and the
// workspace month, and stored paused when either would be exceeded, so a paused hold holds nothing. The render then takes its per-call
// hold under this reservation (renderComposition, authorizeCall), so a call past the hold is refused rather than billed.

import { budgetReservationSchema, type BudgetReservation } from "../contracts/ledger.ts";
import { sumUsd } from "../contracts/money.ts";
import { positionOfLine } from "./line.ts";
import type { LedgerStore } from "./store.ts";

export type ReserveRenderInput = {
  /** A `res_` id. The same id again returns the stored reservation and changes nothing. */
  reservationId: string;
  /** The engine request that delivered the master video. */
  requestId: string;
  workspaceId: string;
  /** The stage the hold is for. A render line. */
  stage: "render";
  estimateUsd: number;
  requestBudgetUsd: number;
  workspaceMonthBudgetUsd: number;
  /** ISO time. Its month decides which monthly budget applies. */
  now: string;
};

export type ReserveRenderResult = { reservation: BudgetReservation; created: boolean };

export async function reserveRenderLine(store: LedgerStore, input: ReserveRenderInput): Promise<ReserveRenderResult> {
  const existing = await store.getReservation(input.reservationId);
  if (existing) return { reservation: existing, created: false };

  const estimateUsd = sumUsd([input.estimateUsd]);
  const totals = await store.sumForMonth(input.workspaceId, input.now.slice(0, 7));
  const monthUsd = sumUsd([totals.reservedUsd, estimateUsd]);
  // The hold is checked against each line the way a paid step is (D17): it starts only if it fits below its line.
  const reasons: string[] = [];
  if (positionOfLine(estimateUsd, input.requestBudgetUsd) === "over_budget") {
    reasons.push(`the request budget of $${input.requestBudgetUsd.toFixed(4)} is below this render's hold of $${estimateUsd.toFixed(4)}`);
  }
  if (positionOfLine(monthUsd, input.workspaceMonthBudgetUsd) === "over_budget") {
    reasons.push(`the workspace month would take $${monthUsd.toFixed(4)} over its $${input.workspaceMonthBudgetUsd.toFixed(4)} budget`);
  }
  const paused = reasons.length > 0;

  const reservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: input.reservationId,
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    mode: "cap",
    lines: [{ stage: input.stage, estimateUsd }],
    estimateUsd,
    redoAllowanceUsd: 0,
    reservedUsd: estimateUsd,
    requestBudgetUsd: input.requestBudgetUsd,
    workspaceMonthBudgetUsd: input.workspaceMonthBudgetUsd,
    state: paused ? "paused" : "reserved",
    ...(paused ? { pausedReason: reasons.join("; ") } : {}),
    createdAt: input.now,
  });
  await store.createReservation(reservation);
  return { reservation, created: true };
}
