// The spend of a request on its ledger, and the pause of its reservations. Moved out of engine/api/index.ts unchanged (coding
// loop, T8). index.ts re-exports the public names.

import { EngineError, roundUsd } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { sqlLedgerStore, withReservationLedger } from "../jobs/sql-ledger-store.ts";
import type { BudgetReservation } from "../contracts/index.ts";

// --- Spend -----------------------------------------------------------------------------------------------------------------

export type EngineSpend = {
  /** Actual cost on the requests' ledger, in micro-dollars. A call whose actual is not recorded yet adds nothing here. */
  totalMicros: number;
  /** The part recorded in the last 24 hours. */
  dailyMicros: number;
  /** Ledger calls with no actual yet. Their cost is unknown, not zero. */
  pendingCalls: number;
};

const MICROS_PER_USD = 1_000_000;

/** The ledger actuals of some requests of one workspace (Bible 14). */

export async function engineSpendOf(sql: Sql, organizationId: string, requestIds: readonly string[]): Promise<EngineSpend> {
  const spend: EngineSpend = { totalMicros: 0, dailyMicros: 0, pendingCalls: 0 };
  // One query per request: a run has a handful, and every value stays a scalar parameter.
  for (const requestId of new Set(requestIds)) {
    const rows = await sql<{ total: string | number; daily: string | number; pending: number }>`
      select coalesce(sum(actual_usd), 0) as total,
        coalesce(sum(actual_usd) filter (where at >= now() - interval '1 day'), 0) as daily,
        (count(*) filter (where actual_usd is null))::int as pending
      from engine_ledger
      where organization_id = ${organizationId} and request_id = ${requestId}
    `;
    spend.totalMicros += Math.round(roundUsd(Number(rows[0]?.total ?? 0)) * MICROS_PER_USD);
    spend.dailyMicros += Math.round(roundUsd(Number(rows[0]?.daily ?? 0)) * MICROS_PER_USD);
    spend.pendingCalls += Number(rows[0]?.pending ?? 0);
  }
  return spend;
}

/**
 * Pauses every live reservation of a request (a Meridian cap or the kill switch was reached). A paused reservation refuses every
 * paid call (budget/reserve.ts, authorizeCall), so the request spends nothing more; the stage that is refused pauses the request
 * with the reason. A paused hold is never revived: a resume makes a new one. Returns how many reservations were paused.
 */
export async function pauseEngineSpend(sql: Sql, organizationId: string, requestId: string, reason: string): Promise<number> {
  if (reason.trim() === "") throw new EngineError("invalid_input", "a reservation is paused with a reason");
  const live = await sql<{ id: string }>`
    select id from engine_reservations
    where organization_id = ${organizationId} and request_id = ${requestId} and state = 'reserved'
    order by id
  `;
  let paused = 0;
  for (const row of live) {
    const changed = await withReservationLedger(sql, organizationId, row.id, async (store) => {
      const reservation = await store.getReservation(row.id);
      if (!reservation || reservation.state !== "reserved") return false;
      await store.updateReservation({ ...reservation, state: "paused", pausedReason: reason.slice(0, 500) });
      return true;
    });
    if (changed) paused += 1;
  }
  return paused;
}

/** Whether a reservation id is paused, for a caller that shows it. Null when the workspace has no such reservation. */

export async function reservationState(sql: Sql, organizationId: string, reservationId: string): Promise<BudgetReservation["state"] | null> {
  const reservation = await sqlLedgerStore(sql, organizationId).getReservation(reservationId);
  return reservation?.state ?? null;
}
