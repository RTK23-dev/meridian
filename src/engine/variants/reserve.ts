// The variants' hold on the request's reservation (Video Engine Bible 6.13, 14.1, 14.4). Each funded variant's estimate is held under
// the request's own reservation, and deliver releases what the variants do not spend (jobs/handlers/deliver.ts, releaseReservation).
//
// The hold is set, not added: it becomes the larger of what it holds and what the committed spend plus the funded variants need.
// So a retried stage raises it to the same amount and writes nothing twice. It is never lowered. In cap mode, a raise that would pass
// the request budget (constraints.budgetUsd) or the workspace's month is refused with the reason, and no variant is funded beyond it.

import { budgetReservationSchema, EngineError, idSchema, roundUsd, sumUsd, usdSchema, type BudgetReservation } from "../contracts/index.ts";
import { committedFor } from "../budget/reserve.ts";
import type { LedgerStore } from "../budget/store.ts";

const STAGE = "variants";

export type VariantReservationInput = {
  reservationId: string;
  /** ProductionRequest.constraints.budgetUsd: the most the request's reservation may hold in cap mode. */
  requestBudgetUsd: number;
  /**
   * The workspace's monthly budget for the month of `now`. Null when it is not connected: a raise is then refused (fail closed), and a
   * funding that needs no raise is still held.
   */
  workspaceMonthBudgetUsd: number | null;
  /** The estimates of the variants that are funded, summed. Zero funds nothing new. */
  plannedUsd: number;
  /** ISO time of the raise. Its month must be the reservation's month (holds are counted in the month they were made). */
  now: string;
};

export type VariantReservationResult =
  /** The variants are funded. `extensionUsd` is what the hold was raised by (zero when the headroom already covered them). */
  | { status: "held"; reservedUsd: number; extensionUsd: number; changed: boolean }
  /** Nothing is written. The reason names the budget that refused the raise. */
  | { status: "refused"; reason: string };

function usdIn(value: number, name: string): number {
  const parsed = usdSchema.safeParse(value);
  if (!parsed.success) throw new EngineError("invalid_input", `${name} must be a USD amount, finite, >= 0, at most 4 decimals`, { stage: STAGE });
  return parsed.data;
}

function refused(reason: string): VariantReservationResult {
  return { status: "refused", reason };
}

/**
 * Funds the planned variants under the reservation. Pure apart from the LedgerStore it is given (the caller passes a row-locked one in
 * production). A reservation that is paused or released funds nothing (it holds nothing and is not revived here).
 */
export async function extendForVariants(store: LedgerStore, input: VariantReservationInput): Promise<VariantReservationResult> {
  const reservationId = idSchema("res_").safeParse(input.reservationId);
  if (!reservationId.success) throw new EngineError("invalid_input", `reservationId ${input.reservationId} is not a res_ id`, { stage: STAGE });
  const planned = usdIn(input.plannedUsd, "plannedUsd");
  const requestBudget = usdIn(input.requestBudgetUsd, "requestBudgetUsd");
  const monthBudget = input.workspaceMonthBudgetUsd === null ? null : usdIn(input.workspaceMonthBudgetUsd, "workspaceMonthBudgetUsd");

  const current: BudgetReservation | null = await store.getReservation(reservationId.data);
  if (current === null) throw new EngineError("not_found", `reservation ${reservationId.data} does not exist`, { stage: STAGE });
  if (current.state !== "reserved") {
    const why = current.pausedReason === undefined ? "" : `: ${current.pausedReason}`;
    return refused(`reservation ${reservationId.data} is ${current.state}${why}; no variant is funded`);
  }
  const month = input.now.slice(0, 7);
  if (month !== current.createdAt.slice(0, 7)) {
    return refused(`reservation ${reservationId.data} was made in ${current.createdAt.slice(0, 7)} and cannot be raised in ${month}; no variant is funded`);
  }

  const committedUsd = await committedFor(store, reservationId.data);
  const target = sumUsd([committedUsd, planned]);
  if (target <= current.reservedUsd) {
    return { status: "held", reservedUsd: current.reservedUsd, extensionUsd: 0, changed: false };
  }

  if (current.mode === "cap") {
    if (target > requestBudget) {
      return refused(
        `the variants would take reservation ${reservationId.data} to ${target} USD, above the request budget of ${requestBudget} USD; no variant is funded beyond it`,
      );
    }
    if (monthBudget === null) {
      return refused("the workspace monthly budget is not connected, so the reservation cannot be raised; no variant is funded beyond it");
    }
    const totals = await store.sumForMonth(current.workspaceId, month);
    const otherReservationsUsd = roundUsd(Math.max(0, totals.reservedUsd - current.reservedUsd));
    const monthTotal = sumUsd([otherReservationsUsd, target]);
    if (monthTotal > monthBudget) {
      return refused(`the workspace monthly budget of ${monthBudget} USD would be exceeded: ${monthTotal} USD committed; no variant is funded`);
    }
  }

  const next = budgetReservationSchema.parse({ ...current, reservedUsd: target });
  await store.updateReservation(next);
  return { status: "held", reservedUsd: target, extensionUsd: roundUsd(target - current.reservedUsd), changed: true };
}
