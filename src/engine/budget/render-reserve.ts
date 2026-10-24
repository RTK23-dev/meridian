// The hold for one repurposed cut's render (Bible 14). It is checked the way the intake hold is: against the request's budget and the
// workspace month, and stored paused when either would be exceeded, so a paused hold holds nothing. The render then takes its per-call
// hold under this reservation (renderComposition, authorizeCall), so a call past the hold is refused rather than billed.

import { budgetReservationSchema, type BudgetReservation } from "../contracts/ledger.ts";
import { sumUsd } from "../contracts/money.ts";
import { limitReasons } from "./preflight.ts";
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
  const { reasons } = limitReasons({ requestBudgetUsd: input.requestBudgetUsd, workspaceMonthBudgetUsd: input.workspaceMonthBudgetUsd, now: input.now }, estimateUsd, monthUsd);
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
