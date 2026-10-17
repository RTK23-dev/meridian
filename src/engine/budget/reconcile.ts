// Settle each paid call to its real cost, then release what was not spent (Video Engine Bible 14.1 steps 4 and 5, as amended for
// contract v6). A call's actual cost is the provider's verified bill, or a confirmation that the call created no job. An estimate is
// never an actual. Without a bill or a confirmation the call stays held at its reservation, and the hold counts toward the budget.

import { EngineError, roundUsd, sumUsd, type BudgetReservation } from "../contracts/index.ts";
import { committedFor, type BudgetAlert } from "./reserve.ts";
import type { LedgerRow, LedgerStore } from "./store.ts";

export type ReconcileInput = {
  /** The idempotency key the call was authorized with. */
  idempotencyKey: string;
  /** The provider's verified bill for the call. Omit when the provider reported none: the call then stays held, and nothing is estimated. */
  billedUsd?: number;
};

export type ReconcileResult = {
  entry: LedgerRow;
  reservation: BudgetReservation;
  alerts: BudgetAlert[];
  /** True when the entry is settled: a bill is recorded, now or before. False while the call stays held. */
  settled: boolean;
};

async function loadCall(store: LedgerStore, idempotencyKey: string): Promise<{ row: LedgerRow; reservation: BudgetReservation }> {
  const row = await store.getEntryByKey(idempotencyKey);
  if (!row) {
    throw new EngineError("not_found", `no ledger entry for idempotency key ${idempotencyKey}`);
  }
  const reservation = await store.getReservation(row.reservationId);
  if (!reservation) {
    throw new EngineError("not_found", `reservation ${row.reservationId} does not exist`, { stage: row.stage });
  }
  return { row, reservation };
}

/**
 * A bill in the ledger's four decimals (usdSchema, the contract's money type). The bill is rounded UP. Rounding to nearest can record up
 * to $0.00005 less than the provider billed, which under-counts a hard budget. Rounding up records at most $0.0001 more, the safe side.
 * Six decimals would need a contract change and a column change (actual_usd is numeric(14, 4)), so they are an owner decision.
 */
function billUsdUp(usd: number): number {
  // The small offset stops a bill that is already on four decimals from rounding up through floating-point noise.
  return Math.ceil(usd * 10000 - 1e-6) / 10000;
}

/**
 * Settle a call to the provider's verified bill. Settling a call twice with the same bill changes nothing; a different bill for a
 * settled call is a conflict. The bill is recorded even when it is above the call's authorized amount: it was spent. What happens
 * next depends on the reservation's mode (settleAndCheck): in cap mode the reservation is marked exceeded and no further paid call is
 * authorized for it.
 */
export async function reconcileCall(store: LedgerStore, input: ReconcileInput): Promise<ReconcileResult> {
  const { row, reservation } = await loadCall(store, input.idempotencyKey);
  if (input.billedUsd === undefined) {
    return { entry: row, reservation, alerts: [], settled: row.settlement !== undefined };
  }
  if (!Number.isFinite(input.billedUsd) || input.billedUsd < 0) {
    throw new EngineError("invalid_input", `a verified bill must be a finite, non-negative USD amount, not ${input.billedUsd}`);
  }
  // The ledger keeps four decimals, as the contract's money type does. The bill is rounded up to them, never estimated and never down.
  const billed = billUsdUp(input.billedUsd);
  if (row.settlement !== undefined) {
    if (row.settlement === "billed" && row.actualUsd === billed) return { entry: row, reservation, alerts: [], settled: true };
    throw new EngineError("conflict", `ledger entry ${row.entryId} is already settled as ${row.settlement}`, { stage: row.stage });
  }
  const entry = await store.settle(row.entryId, { actualUsd: billed, settlement: "billed" });
  return settleAndCheck(store, reservation, entry);
}

/**
 * Settle a call the provider confirmed created no job (a definitive refusal before any job id, Bible 10.4). Its actual cost is 0 by that
 * confirmation, and its hold is released with the reservation. `evidence` says what the provider said, for the audit trail.
 */
export async function confirmAbsentCall(store: LedgerStore, input: { idempotencyKey: string; evidence: string }): Promise<ReconcileResult> {
  if (input.evidence.trim().length === 0) {
    throw new EngineError("invalid_input", "a confirmed absence needs the evidence it rests on");
  }
  const { row, reservation } = await loadCall(store, input.idempotencyKey);
  if (row.settlement !== undefined) {
    if (row.settlement === "confirmed_absent") return { entry: row, reservation, alerts: [], settled: true };
    throw new EngineError("conflict", `ledger entry ${row.entryId} is already settled as ${row.settlement}`, { stage: row.stage });
  }
  const entry = await store.settle(row.entryId, { actualUsd: 0, settlement: "confirmed_absent" });
  return settleAndCheck(store, reservation, entry);
}

/**
 * After a call settles: the reservation's committed amount is what its calls cost, with a hold for each unsettled call. When that is
 * above what the reservation was authorized for, a verified bill has overrun it. In cap mode the reservation becomes exceeded, so no
 * further paid call is authorized for it, and the monthly total keeps the bill (exceeded counts toward the month). In warn mode it is
 * raised with an alert, and in observe mode it is raised silently.
 */
async function settleAndCheck(store: LedgerStore, reservation: BudgetReservation, entry: LedgerRow): Promise<ReconcileResult> {
  const committedUsd = await committedFor(store, reservation.reservationId);
  if (committedUsd <= reservation.reservedUsd) {
    return { entry, reservation, alerts: [], settled: true };
  }

  const message = `settled ${entry.stage} call takes reservation ${reservation.reservationId} to ${committedUsd} USD, above its ${reservation.reservedUsd} USD`;
  const alerts: BudgetAlert[] = [
    { kind: "overrun", scope: "call", limitUsd: reservation.reservedUsd, committedUsd, message },
  ];
  if (reservation.requestBudgetUsd !== undefined && committedUsd > reservation.requestBudgetUsd) {
    alerts.push({
      kind: "overrun",
      scope: "request",
      limitUsd: reservation.requestBudgetUsd,
      committedUsd,
      message: `the request's settled spend is ${committedUsd} USD, above its ${reservation.requestBudgetUsd} USD budget`,
    });
  }

  const next: BudgetReservation =
    reservation.mode === "cap"
      ? {
          ...reservation,
          state: "exceeded",
          reservedUsd: roundUsd(committedUsd),
          pausedReason: `${message}; no further paid call is authorized for this reservation`,
        }
      : { ...reservation, reservedUsd: roundUsd(committedUsd) };
  await store.updateReservation(next);
  return {
    entry,
    reservation: next,
    alerts: reservation.mode === "observe" ? [] : alerts,
    settled: true,
  };
}

export type ReleaseResult = {
  reservation: BudgetReservation;
  releasedUsd: number;
};

/**
 * Release the unused part of a reservation (Bible 14.1 step 5). The reservation's amount drops to what is committed, so the monthly
 * total gives back the rest. A call that is still held keeps its hold, so a reservation with an unsettled call releases nothing for it.
 * Releasing twice is a no-op, and so is releasing a reservation that is paused or exceeded.
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

/** The held amount of the reservation's calls that have no settlement yet, in USD. Operators read this to see what is unresolved. */
export async function unsettledHoldUsd(store: LedgerStore, reservationId: string): Promise<number> {
  const rows = await store.listEntries(reservationId);
  return sumUsd(rows.filter((row) => row.settlement === undefined).map((row) => row.reservedUsd));
}
