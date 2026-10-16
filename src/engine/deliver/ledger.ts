// Settles the request's ledger at delivery (Video Engine Bible 14.1 steps 4 and 5). Every entry without an actual cost is reconciled
// (reconcileCall: the provider's bill, else the list price, else the held amount, always flagged as an estimate when it is not a
// bill). Then the reservation is released, so it holds only what was committed. Both steps are idempotent: a second run changes
// nothing and returns the same lines. Pure over the LedgerStore port; the handler decides which store (a row-locked one in production).

import { reconcileCall, releaseReservation, type ReleaseResult } from "../budget/reconcile.ts";
import type { LedgerRow, LedgerStore } from "../budget/store.ts";
import { EngineError } from "../contracts/index.ts";

/** A ledger row whose actual cost is known: the provider's bill, or the flagged estimate. */
export type SettledRow = LedgerRow & { actualUsd: number };

export type SettleResult = {
  /** Every entry of the reservation after settlement, in the order the store lists them. */
  rows: SettledRow[];
  /** The entries this run reconciled (a run that finds them settled reconciles none). */
  reconciled: string[];
  release: ReleaseResult;
};

/** Reconciles the open entries of one reservation, then releases the rest. Throws when the reservation does not exist. */
export async function settleLedger(ledger: LedgerStore, reservationId: string): Promise<SettleResult> {
  const before = await ledger.listEntries(reservationId);
  const reconciled: string[] = [];
  for (const row of before) {
    if (row.actualUsd !== undefined) continue;
    await reconcileCall(ledger, { idempotencyKey: row.idempotencyKey });
    reconciled.push(row.entryId);
  }
  const release = await releaseReservation(ledger, reservationId);
  const after = await ledger.listEntries(reservationId);
  const rows = after.map((row) => {
    if (row.actualUsd === undefined) {
      throw new EngineError("internal", `ledger entry ${row.entryId} has no actual cost after reconciliation`, { stage: row.stage });
    }
    return { ...row, actualUsd: row.actualUsd };
  });
  return { rows, reconciled, release };
}
