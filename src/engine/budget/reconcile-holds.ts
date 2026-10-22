// The reconciler of held calls (contract v9, Video Engine Bible 14.1 step 4). A paid call whose provider named it (its providerRef) but
// whose bill did not arrive stays held at its reservation. This settles such a call once its bill can be read, and reports the rest.
// It settles only to a verified bill: no bill, no settlement, and nothing is estimated (contract v6). A held call with no providerRef is
// never read: nothing names the provider's record of it, so it is given up once and reported for an operator.
//
// Reads are tracked in engine_bill_reads (migration 0111), one row per held call that has been read or given up. A held call is read at
// most MAX_BILL_READS times ever: the Nth failed read waits BILL_READ_BACKOFF_MS[N-1], and the MAX_BILL_READS-th failure gives reading up.
// A read that returns a bill settles the call through reconcileCall, then its tracking row is deleted. Tracking never changes the ledger row.
//
// This is the one file of this folder that reads the database. It reads the workspace's unsettled rows, and settles each one under its
// reservation's row lock (jobs/sql-ledger-store.ts, the lock the router uses). A bill is read outside the lock: the provider is never
// called while a row is locked. Each read is claimed in engine_bill_reads before the provider is called, so a run that overlaps another
// run for the same workspace does not read the same call twice.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { withReservationLedger } from "../jobs/sql-ledger-store.ts";
import { reconcileCall } from "./reconcile.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A held call is read only once it is this old, so that its bill has had time to be recorded (contract v9). */
export const HOLD_SETTLE_AFTER_MS = 5 * MINUTE_MS;

/** The most held calls one run reads, and the most it gives up. The rest stay unsettled and are read by the next run, oldest first. */
export const HOLD_BATCH_LIMIT = 100;

/**
 * The wait after the Nth failed read is at index N-1. The fifth failure gives reading up, so it has no wait. The schedule is the lead's
 * decision for contract v9; it is kept here beside the other hold constants.
 */
export const BILL_READ_BACKOFF_MS: readonly number[] = [15 * MINUTE_MS, 60 * MINUTE_MS, 4 * HOUR_MS, 12 * HOUR_MS];

/** The most reads one held call ever gets. The read that fails this many times gives the call up. */
export const MAX_BILL_READS = 5;

/** A read in flight holds its call for this long, so an overlapping run skips it. The read's outcome replaces the lease. */
export const BILL_READ_LEASE_MS = 10 * MINUTE_MS;

/** The reason a held call with no providerRef is given up with. Such a call is never read. */
export const NO_PROVIDER_REF_REASON = "no provider reference";

/** The reason a claimed read carries until its outcome is recorded. It stays only when the run that claimed the read did not finish. */
const READ_IN_FLIGHT_REASON = "a bill read was in flight and did not finish";

/** The longest reason engine_bill_reads.last_reason keeps (its check constraint). */
const LAST_REASON_MAX = 500;

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
  /**
   * Held calls with no providerRef that are still unsettled, oldest first, at most HOLD_BATCH_LIMIT ids. The count is the total. Each
   * one is given up on its first run, and is never read, so an operator resolves it.
   */
  needsOperator: HoldGroup;
  /**
   * Calls this run stopped reading for good: a held call with no providerRef, given up in this run (at most HOLD_BATCH_LIMIT), or a
   * call whose fifth read failed. Such a call is also in stillOpen or needsOperator, and is never read again.
   */
  givenUp: HoldGroup;
};

type HoldRow = {
  id: string;
  reservation_id: string;
  idempotency_key: string;
  provider: string;
  provider_ref: string;
};

function group(ids: string[]): HoldGroup {
  return { count: ids.length, ids };
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error").replace(/\s+/g, " ").slice(0, 300);
}

function clipReason(reason: string): string {
  return String(reason).replace(/\s+/g, " ").slice(0, LAST_REASON_MAX);
}

/**
 * Claims one read of a held call before its provider is called. The claim is the read: it counts in `attempts`, and holds the call for
 * BILL_READ_LEASE_MS. It takes the call only while the call is unsettled, not given up, and due (its next read is not later than now),
 * so two overlapping runs cannot both claim the same read, and a call settled after it was selected is not read.
 *
 * The claim that takes the last allowed read gives the call up at once. So a run that dies during that read leaves the call given up,
 * and no read after it can exceed MAX_BILL_READS. A read cut off earlier is read again when its lease ends, and it counts.
 * Returns the read's number, or null when the call is not claimable.
 */
async function claimRead(sql: Sql, organizationId: string, entryId: string, nowMs: number): Promise<number | null> {
  const firstReadIsLast = MAX_BILL_READS <= 1;
  const rows = await sql<{ attempts: number }>`
    insert into engine_bill_reads (ledger_entry_id, organization_id, attempts, next_read_at, given_up, last_reason, updated_at)
    select l.id, l.organization_id, 1, ${isoOf(nowMs + BILL_READ_LEASE_MS)}::timestamptz, ${firstReadIsLast}::boolean,
      ${READ_IN_FLIGHT_REASON}::text, ${isoOf(nowMs)}::timestamptz
    from engine_ledger l
    where l.id = ${entryId} and l.organization_id = ${organizationId} and l.settlement is null
    on conflict (ledger_entry_id) do update
      set attempts = engine_bill_reads.attempts + 1,
          next_read_at = excluded.next_read_at,
          given_up = (engine_bill_reads.attempts + 1 >= ${MAX_BILL_READS}::int),
          last_reason = excluded.last_reason,
          updated_at = excluded.updated_at
      where engine_bill_reads.given_up = false
        and (engine_bill_reads.next_read_at is null or engine_bill_reads.next_read_at <= ${isoOf(nowMs)}::timestamptz)
    returning attempts
  `;
  const row = rows[0];
  return row === undefined ? null : Number(row.attempts);
}

/**
 * Records a failed read of a claimed call. The Nth failure waits BILL_READ_BACKOFF_MS[N-1]. The MAX_BILL_READS-th failure gives the call
 * up: it has no next read. Returns true when the call is given up now.
 */
async function recordFailedRead(sql: Sql, organizationId: string, entryId: string, attempts: number, reason: string, nowMs: number): Promise<boolean> {
  const wait: number | undefined = BILL_READ_BACKOFF_MS[attempts - 1];
  // A missing wait (a schedule shorter than the read limit) fails closed: the call is given up, not read again.
  const givenUp = attempts >= MAX_BILL_READS || wait === undefined;
  const nextReadAt = wait === undefined || givenUp ? null : isoOf(nowMs + wait);
  await sql`
    update engine_bill_reads
    set next_read_at = ${nextReadAt}::timestamptz,
        given_up = ${givenUp},
        last_reason = ${clipReason(reason)},
        updated_at = ${isoOf(nowMs)}::timestamptz
    where ledger_entry_id = ${entryId} and organization_id = ${organizationId}
  `;
  return givenUp;
}

/**
 * Settles the held calls of one workspace whose bill is now readable. `now` is epoch milliseconds. Only a call at least
 * HOLD_SETTLE_AFTER_MS old is read. Every other unsettled call of the workspace is outside this run.
 *
 * Order of a run: the tracking rows are brought in line with the ledger (a call settled by another path is untracked; a call with no
 * providerRef that has since gained one is read again). Then the calls with no providerRef are given up, at most HOLD_BATCH_LIMIT of them.
 * Then the due calls (with a providerRef, not given up, not waiting for a later read) are read, oldest first, at most HOLD_BATCH_LIMIT.
 */
export async function reconcileHolds(
  sql: Sql,
  input: { organizationId: string; now: number; readers: Partial<Record<string, BillReader>> },
): Promise<ReconcileHoldsResult> {
  const { organizationId } = input;
  const nowMs = input.now;
  const nowIso = isoOf(nowMs);
  const cutoff = isoOf(nowMs - HOLD_SETTLE_AFTER_MS);

  await sql`
    delete from engine_bill_reads b
    using engine_ledger l
    where b.ledger_entry_id = l.id and b.organization_id = ${organizationId} and l.settlement is not null
  `;
  // A call given up for having no providerRef made no provider request. If it has a ref now, it is read like any other call.
  await sql`
    delete from engine_bill_reads b
    using engine_ledger l
    where b.ledger_entry_id = l.id and b.organization_id = ${organizationId}
      and b.given_up and b.attempts = 0 and b.last_reason = ${NO_PROVIDER_REF_REASON} and l.provider_ref is not null
  `;

  const givenUpNow = await sql<{ ledger_entry_id: string }>`
    insert into engine_bill_reads (ledger_entry_id, organization_id, attempts, next_read_at, given_up, last_reason, updated_at)
    select l.id, l.organization_id, 0::int, null::timestamptz, true, ${NO_PROVIDER_REF_REASON}::text, ${nowIso}::timestamptz
    from engine_ledger l
    where l.organization_id = ${organizationId} and l.settlement is null and l.at <= ${cutoff}::timestamptz and l.provider_ref is null
      and not exists (select 1 from engine_bill_reads b where b.ledger_entry_id = l.id)
    order by l.at asc, l.id asc
    limit ${HOLD_BATCH_LIMIT}
    on conflict (ledger_entry_id) do nothing
    returning ledger_entry_id
  `;

  const outstanding = await sql<{ ledger_entry_id: string; total: number }>`
    select b.ledger_entry_id, (count(*) over ())::int as total
    from engine_bill_reads b
    join engine_ledger l on l.id = b.ledger_entry_id
    where b.organization_id = ${organizationId} and b.given_up and b.last_reason = ${NO_PROVIDER_REF_REASON}
      and l.settlement is null and l.provider_ref is null
    order by l.at asc, l.id asc
    limit ${HOLD_BATCH_LIMIT}
  `;

  const rows = await sql<HoldRow>`
    select l.id, l.reservation_id, l.idempotency_key, l.provider, l.provider_ref
    from engine_ledger l
    left join engine_bill_reads b on b.ledger_entry_id = l.id
    where l.organization_id = ${organizationId} and l.settlement is null and l.at <= ${cutoff}::timestamptz
      and l.provider_ref is not null
      and (b.ledger_entry_id is null
        or (b.given_up = false and (b.next_read_at is null or b.next_read_at <= ${nowIso}::timestamptz)))
    order by l.at asc, l.id asc
    limit ${HOLD_BATCH_LIMIT}
  `;

  const settled: string[] = [];
  const stillOpen: Array<{ entryId: string; reason: string }> = [];
  const givenUp: string[] = givenUpNow.map((row) => row.ledger_entry_id);

  for (const row of rows) {
    const attempts = await claimRead(sql, organizationId, row.id, nowMs);
    if (attempts === null) continue;

    const fail = async (reason: string): Promise<void> => {
      stillOpen.push({ entryId: row.id, reason });
      if (await recordFailedRead(sql, organizationId, row.id, attempts, reason, nowMs)) givenUp.push(row.id);
    };

    const reader = input.readers[row.provider];
    if (reader === undefined) {
      await fail(`no bill reader is wired for ${row.provider}`);
      continue;
    }

    let read: BillRead;
    try {
      read = await reader({ organizationId, providerRef: row.provider_ref });
    } catch (error) {
      read = { status: "unavailable", reason: `the bill read failed: ${messageOf(error)}` };
    }
    if (read.status === "unavailable") {
      await fail(read.reason);
      continue;
    }
    const billedUsd = read.usd;

    try {
      await withReservationLedger(sql, organizationId, row.reservation_id, (store) =>
        reconcileCall(store, { idempotencyKey: row.idempotency_key, billedUsd }),
      );
    } catch (error) {
      await fail(`the settlement was refused: ${messageOf(error)}`);
      continue;
    }
    await sql`delete from engine_bill_reads where ledger_entry_id = ${row.id} and organization_id = ${organizationId}`;
    settled.push(row.id);
  }

  return {
    settled: group(settled),
    stillOpen: { ...group(stillOpen.map((item) => item.entryId)), reasons: stillOpen },
    needsOperator: { count: outstanding[0]?.total ?? 0, ids: outstanding.map((row) => row.ledger_entry_id) },
    givenUp: group(givenUp),
  };
}
