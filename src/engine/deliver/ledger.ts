// Settles the request's ledger at delivery (Video Engine Bible 14.1 steps 4 and 5, as amended for contract v6). A request is delivered
// only when every paid call of it is settled: each has the provider's verified bill, or a confirmation that it created no job. An open
// call is never estimated into a cost. Delivery names the open calls and stops, so an operator settles them (resolveAmbiguousSubmit,
// confirmAbsentCall, or a bill recorded for the render) and replays the delivery. When every call is settled the reservation is released,
// so it holds only what was committed. The step is idempotent: a second run changes nothing and returns the same rows.

import { releaseReservation, type ReleaseResult } from "../budget/reconcile.ts";
import type { LedgerRow, LedgerStore } from "../budget/store.ts";
import { EngineError } from "../contracts/index.ts";

/** A ledger row whose actual cost is known: the provider's verified bill, or a confirmed absence (0). */
export type SettledRow = LedgerRow & { actualUsd: number };

export type SettleResult = {
  /** Every entry of the reservation, all settled, in the order the store lists them. */
  rows: SettledRow[];
  release: ReleaseResult;
};

/**
 * Checks that every entry of the reservation is settled, then releases the rest. Throws, without releasing anything, when a call is
 * still open: the delivery is refused and names the open calls, so the operator settles them first. Throws when the reservation does not
 * exist.
 */
export async function settleLedger(ledger: LedgerStore, reservationId: string): Promise<SettleResult> {
  const entries = await ledger.listEntries(reservationId);
  const open = entries.filter((row) => row.settlement === undefined || row.actualUsd === undefined);
  if (open.length > 0) {
    const names = open.map((row) => `${row.stage} ${row.idempotencyKey}`).join(", ");
    throw new EngineError(
      "conflict",
      `${open.length} paid call(s) have no settled cost and the request is not delivered until each is settled from its bill or confirmed absent: ${names}`,
      { stage: "deliver", retryable: false },
    );
  }
  const release = await releaseReservation(ledger, reservationId);
  const rows = entries.map((row) => {
    if (row.actualUsd === undefined) {
      throw new EngineError("internal", `ledger entry ${row.entryId} is settled but has no actual cost`, { stage: row.stage });
    }
    return { ...row, actualUsd: row.actualUsd };
  });
  return { rows, release };
}
