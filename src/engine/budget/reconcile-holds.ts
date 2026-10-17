// The reconciler of held calls (contract v9, Video Engine Bible 14.1 step 4). A paid call whose provider named it (its providerRef) but
// whose bill did not arrive stays held at its reservation. This settles such a call once its bill can be read, and reports the rest.
// It settles only to a verified bill: no bill, no settlement, and nothing is estimated (contract v6). A held call with no providerRef is
// never settled here, because nothing names the provider's record of it: it is reported for an operator.
//
// This is the one file of this folder that reads the database. It reads the workspace's unsettled rows, and settles each one under its
// reservation's row lock (jobs/sql-ledger-store.ts, the lock the router uses). A bill is read outside the lock: the provider is never
// called while a row is locked.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { withReservationLedger } from "../jobs/sql-ledger-store.ts";
import { reconcileCall } from "./reconcile.ts";

/** A held call is read only once it is this old, so that its bill has had time to be recorded (contract v9). */
export const HOLD_SETTLE_AFTER_MS = 5 * 60 * 1000;

/** The most held calls one run reads. The rest stay unsettled and are read by the next run, oldest first. */
export const HOLD_BATCH_LIMIT = 100;

/** A provider's bill for one call, from the call's own id. Unavailable is a miss, never a bill of zero. */
export type BillRead = { status: "billed"; usd: number } | { status: "unavailable"; reason: string };

/** Reads the bill of one call from its providerRef, for one workspace. Keyed by provider in `readers`. */
export type BillReader = (input: { organizationId: string; providerRef: string }) => Promise<BillRead>;

export type HoldGroup = { count: number; ids: string[] };

export type ReconcileHoldsResult = {
  /** Calls settled to their bill in this run. */
  settled: HoldGroup;
  /** Calls read this run whose bill is still not available, with the reason for each. They stay held. */
  stillOpen: HoldGroup & { reasons: Array<{ entryId: string; reason: string }> };
  /** Held calls with no providerRef. Nothing can read their bill, so an operator resolves them. */
  needsOperator: HoldGroup;
};

type HoldRow = {
  id: string;
  reservation_id: string;
  idempotency_key: string;
  provider: string;
  provider_ref: string | null;
};

function group(ids: string[]): HoldGroup {
  return { count: ids.length, ids };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Settles the held calls of one workspace whose bill is now readable. `now` is epoch milliseconds. Only a call at least
 * HOLD_SETTLE_AFTER_MS old is read. Every other unsettled call of the workspace is outside this run.
 */
export async function reconcileHolds(
  sql: Sql,
  input: { organizationId: string; now: number; readers: Partial<Record<string, BillReader>> },
): Promise<ReconcileHoldsResult> {
  const { organizationId } = input;
  const cutoff = new Date(input.now - HOLD_SETTLE_AFTER_MS).toISOString();
  const rows = await sql<HoldRow>`
    select id, reservation_id, idempotency_key, provider, provider_ref
    from engine_ledger
    where organization_id = ${organizationId} and settlement is null and at <= ${cutoff}::timestamptz
    order by at asc, id asc
    limit ${HOLD_BATCH_LIMIT}
  `;

  const settled: string[] = [];
  const stillOpen: Array<{ entryId: string; reason: string }> = [];
  const needsOperator: string[] = [];

  for (const row of rows) {
    if (row.provider_ref === null) {
      needsOperator.push(row.id);
      continue;
    }
    const reader = input.readers[row.provider];
    if (reader === undefined) {
      stillOpen.push({ entryId: row.id, reason: `no bill reader is wired for ${row.provider}` });
      continue;
    }

    let read: BillRead;
    try {
      read = await reader({ organizationId, providerRef: row.provider_ref });
    } catch (error) {
      read = { status: "unavailable", reason: `the bill read failed: ${messageOf(error)}` };
    }
    if (read.status === "unavailable") {
      stillOpen.push({ entryId: row.id, reason: read.reason });
      continue;
    }
    const billedUsd = read.usd;

    try {
      await withReservationLedger(sql, organizationId, row.reservation_id, (store) =>
        reconcileCall(store, { idempotencyKey: row.idempotency_key, billedUsd }),
      );
      settled.push(row.id);
    } catch (error) {
      stillOpen.push({ entryId: row.id, reason: `the settlement was refused: ${messageOf(error)}` });
    }
  }

  return {
    settled: group(settled),
    stillOpen: { ...group(stillOpen.map((item) => item.entryId)), reasons: stillOpen },
    needsOperator: group(needsOperator),
  };
}
