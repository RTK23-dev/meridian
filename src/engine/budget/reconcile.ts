// Reconcile each paid call to what it really cost, then release what was not spent (Bible 14.1 steps 4 and 5).

import { EngineError, roundUsd, type BudgetReservation } from "../contracts/index.ts";
import { committedFor, type BudgetAlert } from "./reserve.ts";
import type { LedgerRow, LedgerStore } from "./store.ts";

export type ReconcileInput = {
  /** The idempotency key the call was authorized with. */
  idempotencyKey: string;
  /** The provider's own bill for the call, when known. */
  actualUsd?: number;
  /**
   * The adapter's list price for the call (its price() result), used when no bill is known. Flagged as an estimate.
   * When neither a bill nor a list price is available, the held amount is recorded instead, also flagged.
   */
  listPriceUsd?: number | null;
};

export type ReconcileResult = {
  entry: LedgerRow;
  reservation: BudgetReservation;
  alerts: BudgetAlert[];
};

/**
 * Record the actual cost of one call. Reconciling a call twice changes nothing the second time.
 * If the committed total now exceeds the reservation, the reservation is raised to match and an overrun alert is
 * returned (warn and cap modes); observe mode records silently.
 */
export async function reconcileCall(store: LedgerStore, input: ReconcileInput): Promise<ReconcileResult> {
  const row = await store.getEntryByKey(input.idempotencyKey);
  if (!row) {
    throw new EngineError("not_found", `no ledger entry for idempotency key ${input.idempotencyKey}`);
  }
  const reservation = await store.getReservation(row.reservationId);
  if (!reservation) {
    throw new EngineError("not_found", `reservation ${row.reservationId} does not exist`, { stage: row.stage });
  }

  if (row.actualUsd !== undefined) {
    return { entry: row, reservation, alerts: [] };
  }

  let actualUsd: number;
  let actualIsEstimate: boolean;
  if (input.actualUsd !== undefined) {
    actualUsd = roundUsd(input.actualUsd);
    actualIsEstimate = false;
  } else if (input.listPriceUsd !== undefined && input.listPriceUsd !== null) {
    actualUsd = roundUsd(input.listPriceUsd);
    actualIsEstimate = true;
  } else {
    actualUsd = row.reservedUsd;
    actualIsEstimate = true;
  }

  const entry = await store.setActual(row.entryId, { actualUsd, actualIsEstimate });

  const committedUsd = await committedFor(store, reservation.reservationId);
  if (committedUsd <= reservation.reservedUsd) {
    return { entry, reservation, alerts: [] };
  }

  const raised: BudgetReservation = { ...reservation, reservedUsd: roundUsd(committedUsd) };
  await store.updateReservation(raised);
  const message = `reconciled ${row.stage} takes reservation ${reservation.reservationId} to ${committedUsd} USD, above its ${reservation.reservedUsd} USD`;
  return {
    entry,
    reservation: raised,
    alerts:
      reservation.mode === "observe"
        ? []
        : [
            {
              kind: "overrun",
              scope: "call",
              limitUsd: reservation.reservedUsd,
              committedUsd,
              message,
            },
          ],
  };
}

export type ReleaseResult = {
  reservation: BudgetReservation;
  releasedUsd: number;
};

/**
 * Release the unused part of a reservation (Bible 14.1 step 5). The reservation's amount drops to what is committed,
 * so the monthly total gives back the rest. Calls still open keep their hold. Releasing twice is a no-op.
 */
export async function releaseReservation(store: LedgerStore, reservationId: string): Promise<ReleaseResult> {
  const reservation = await store.getReservation(reservationId);
  if (!reservation) {
    throw new EngineError("not_found", `reservation ${reservationId} does not exist`);
  }
  if (reservation.state !== "reserved") {
    return { reservation, releasedUsd: 0 };
  }

  const committedUsd = await committedFor(store, reservationId);
  const releasedUsd = roundUsd(Math.max(0, reservation.reservedUsd - committedUsd));
  const released: BudgetReservation = {
    ...reservation,
    state: "released",
    reservedUsd: roundUsd(committedUsd),
  };
  await store.updateReservation(released);
  return { reservation: released, releasedUsd };
}
