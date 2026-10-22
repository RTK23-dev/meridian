// The bill reads of held calls are tracked in engine_bill_reads and bounded (budget/reconcile-holds.ts, migration 0110). A held call is read
// at most MAX_BILL_READS times, each wait follows BILL_READ_BACKOFF_MS, a call with no providerRef is never read, and a settled call is
// never read again. The clock is injected, the database is the test database, and every bill is a recorded fixture: no live API is called.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { budgetReservationSchema, newId } from "../contracts/index.ts";
import { authorizeCall, type CallInput } from "./reserve.ts";
import { reconcileCall } from "./reconcile.ts";
import {
  BILL_READ_BACKOFF_MS,
  HOLD_BATCH_LIMIT,
  MAX_BILL_READS,
  NO_PROVIDER_REF_REASON,
  reconcileHolds,
  type BillRead,
  type BillReader,
  type ReconcileHoldsResult,
} from "./reconcile-holds.ts";
import { withReservationLedger, withWorkspaceLedger } from "../jobs/sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = Date.parse("2026-10-17T10:00:00.000Z");
/** An hour before now: older than the settle-after age. */
const OLD = "2026-10-17T09:00:00.000Z";
/** Half an hour before now, older than OLD: the calls the batch tests crowd the oldest-first order with. */
const OLDER = "2026-10-17T09:30:00.000Z";
const UNAVAILABLE_REASON = "the generation stats have not arrived";
const UNAVAILABLE: BillRead = { status: "unavailable", reason: UNAVAILABLE_REASON };
/** Recorded bills. Any other ref has no bill yet. */
const BILLS: Record<string, number> = { "gen-billed-1": 0.0031, "gen-billed-2": 0.0042 };

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

type Workspace = { organizationId: string; requestId: string };

async function workspace(label: string): Promise<Workspace> {
  const organizationId = `ws_reads_${label}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const requestId = newId("req_");
  await seedWorkspace(db.sql, organizationId);
  await db.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, state)
    values (${requestId}, ${organizationId}, 'fmt_reads', 'normal', 'running', '{}')
  `;
  return { organizationId, requestId };
}

/** A reservation large enough for the batch tests: 240 calls of 0.02 each fit under it. */
async function reservationFor({ organizationId, requestId }: Workspace): Promise<string> {
  const reservationId = newId("res_");
  const reservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId,
    requestId,
    workspaceId: organizationId,
    mode: "cap",
    lines: [{ stage: "voice", estimateUsd: 1000 }],
    estimateUsd: 1000,
    redoAllowanceUsd: 0,
    reservedUsd: 1000,
    state: "reserved",
    createdAt: "2026-10-17T08:00:00.000Z",
  });
  await withWorkspaceLedger(db.sql, organizationId, (store) => store.createReservation(reservation));
  return reservationId;
}

/** One authorized call, held at its estimate. With a providerRef, the provider's id is recorded on it (no bill). */
async function heldCall(
  organizationId: string,
  reservationId: string,
  options: { at: string; key: string; providerRef?: string },
): Promise<string> {
  const input: CallInput = {
    reservationId,
    stage: "voice",
    provider: "openrouter",
    model: "elevenlabs/eleven-v4",
    estimateUsd: 0.02,
    idempotencyKey: options.key,
    at: options.at,
  };
  const authorized = await withReservationLedger(db.sql, organizationId, reservationId, (store) => authorizeCall(store, input));
  assert.equal(authorized.status, "authorized");
  if (options.providerRef !== undefined) {
    await withReservationLedger(db.sql, organizationId, reservationId, (store) =>
      reconcileCall(store, { idempotencyKey: options.key, providerRef: options.providerRef }),
    );
  }
  return authorized.entry.entryId;
}

type Ledger = { settlement: string | null; actualUsd: number | null; providerRef: string | null };

async function ledgerOf(entryId: string): Promise<Ledger> {
  const rows = await db.sql<{ settlement: string | null; actual_usd: string | number | null; provider_ref: string | null }>`
    select settlement, actual_usd, provider_ref from engine_ledger where id = ${entryId}
  `;
  const row = rows[0];
  assert.ok(row, `ledger row ${entryId} exists`);
  return {
    settlement: row.settlement,
    actualUsd: row.actual_usd === null ? null : Number(row.actual_usd),
    providerRef: row.provider_ref,
  };
}

type Tracking = { attempts: number; nextReadAt: number | null; givenUp: boolean; lastReason: string };

/** The tracking row of a held call, or null when there is none (never read, or settled and deleted). */
async function trackingOf(entryId: string): Promise<Tracking | null> {
  const rows = await db.sql<{ attempts: number; next_read_at: unknown; given_up: boolean; last_reason: string }>`
    select attempts, next_read_at, given_up, last_reason from engine_bill_reads where ledger_entry_id = ${entryId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    attempts: Number(row.attempts),
    nextReadAt: row.next_read_at === null ? null : new Date(row.next_read_at as string | Date).getTime(),
    givenUp: row.given_up,
    lastReason: row.last_reason,
  };
}

async function requireTracking(entryId: string): Promise<Tracking & { nextReadAt: number }> {
  const tracking = await trackingOf(entryId);
  assert.ok(tracking, `a tracking row exists for ${entryId}`);
  assert.notEqual(tracking.nextReadAt, null, `a tracking row for ${entryId} has a next read`);
  return { ...tracking, nextReadAt: tracking.nextReadAt as number };
}

/**
 * A bill reader that records each ref it is asked for, and answers with `answer`. `nth` is how many times that ref has been asked
 * (1 for the first). A throwing answer is a reader that fails.
 */
function fakeReader(answer: (providerRef: string, nth: number) => BillRead): { reader: BillReader; reads: string[]; readsOf: (ref: string) => number } {
  const reads: string[] = [];
  const reader: BillReader = async ({ providerRef }) => {
    reads.push(providerRef);
    const nth = reads.filter((ref) => ref === providerRef).length;
    return answer(providerRef, nth);
  };
  return { reader, reads, readsOf: (ref) => reads.filter((read) => read === ref).length };
}

function billedAnswer(providerRef: string): BillRead {
  const usd = BILLS[providerRef];
  return usd === undefined ? UNAVAILABLE : { status: "billed", usd };
}

function runAt(organizationId: string, now: number, reader: BillReader | undefined): Promise<ReconcileHoldsResult> {
  return reconcileHolds(db.sql, { organizationId, now, readers: { openrouter: reader } });
}

/**
 * The state a run leaves when it dies in the middle of a read: the claim is stored (it counts as a read), and no outcome is. `leaseEndsAt`
 * is when the claim's lease ends (epoch milliseconds).
 */
async function cutOffRead(organizationId: string, entryId: string, attempts: number, leaseEndsAt: number): Promise<void> {
  const leaseIso = new Date(leaseEndsAt).toISOString();
  await db.sql`
    insert into engine_bill_reads (ledger_entry_id, organization_id, attempts, next_read_at, given_up, last_reason, updated_at)
    values (${entryId}, ${organizationId}, ${attempts}, ${leaseIso}::timestamptz, false,
      'a bill read was in flight and did not finish', ${leaseIso}::timestamptz)
  `;
}

describe("bill reads of held calls are tracked and bounded (budget/reconcile-holds.ts, migration 0110)", () => {
  it("the schedule and the limits are the contract's: five reads, waits of 15 minutes, 1 hour, 4 hours and 12 hours", () => {
    assert.deepEqual([...BILL_READ_BACKOFF_MS], [15 * MINUTE_MS, HOUR_MS, 4 * HOUR_MS, 12 * HOUR_MS]);
    assert.equal(MAX_BILL_READS, 5);
    assert.equal(BILL_READ_BACKOFF_MS.length, MAX_BILL_READS - 1, "one wait between each pair of reads");
    assert.equal(HOLD_BATCH_LIMIT, 100);
    assert.equal(NO_PROVIDER_REF_REASON, "no provider reference");
  });

  it("a call whose bill never arrives is read at most five times, however many runs there are, and then given up", async () => {
    const ws = await workspace("five");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "five:1", providerRef: "gen-never-1" });
    const fake = fakeReader(() => UNAVAILABLE);
    let now = NOW_MS;
    let givenUpResult: ReconcileHoldsResult | undefined;
    for (let run = 0; run < 40; run += 1) {
      const result = await runAt(ws.organizationId, now, fake.reader);
      if (result.givenUp.count > 0) givenUpResult = result;
      const tracking = await trackingOf(entryId);
      // Move the clock past the next read; once given up there is none, so jump far ahead and the run must still read nothing.
      now = tracking?.nextReadAt ?? now + 400 * DAY_MS;
    }

    assert.equal(fake.readsOf("gen-never-1"), MAX_BILL_READS);
    const tracking = await trackingOf(entryId);
    assert.ok(tracking);
    assert.equal(tracking.attempts, MAX_BILL_READS);
    assert.equal(tracking.givenUp, true, "the row ends given up");
    assert.equal(tracking.nextReadAt, null);
    assert.equal(tracking.lastReason, UNAVAILABLE_REASON);
    assert.ok(givenUpResult, "the fifth failure is reported as given up in its run");
    assert.deepEqual(givenUpResult.givenUp.ids, [entryId]);
    assert.deepEqual(givenUpResult.stillOpen.ids, [entryId], "the call stays held, with the reason");
    assert.equal((await ledgerOf(entryId)).settlement, null, "a call that was never read is never settled");
  });

  it("no read happens before next_read_at, and each wait is the schedule's", async () => {
    const ws = await workspace("schedule");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "schedule:1", providerRef: "gen-never-2" });
    const fake = fakeReader(() => UNAVAILABLE);
    let failedAt = NOW_MS;
    await runAt(ws.organizationId, failedAt, fake.reader);
    assert.equal(fake.reads.length, 1);

    for (let failure = 1; failure < MAX_BILL_READS; failure += 1) {
      const due = (await requireTracking(entryId)).nextReadAt;
      assert.equal(due - failedAt, BILL_READ_BACKOFF_MS[failure - 1], `the wait after failed read ${failure}`);

      await runAt(ws.organizationId, due - 1, fake.reader);
      assert.equal(fake.reads.length, failure, `no read one millisecond before the wait after read ${failure} ends`);

      await runAt(ws.organizationId, due, fake.reader);
      assert.equal(fake.reads.length, failure + 1, `a read is made when the wait after read ${failure} ends`);
      failedAt = due;
    }
    const final = await trackingOf(entryId);
    assert.equal(final?.attempts, MAX_BILL_READS);
    assert.equal(final?.givenUp, true, "the last allowed read's failure gives the call up: no next read");
    assert.equal(final?.nextReadAt, null);
  });

  it("given-up calls and calls with no provider ref do not stop newer calls from being read, even past one hundred of them", async () => {
    const ws = await workspace("crowd");
    const reservationId = await reservationFor(ws);
    const noRef: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      noRef.push(await heldCall(ws.organizationId, reservationId, { at: OLDER, key: `crowd:no-ref:${index}` }));
    }
    for (let index = 0; index < 120; index += 1) {
      const entryId = await heldCall(ws.organizationId, reservationId, { at: OLDER, key: `crowd:given-up:${index}`, providerRef: `gen-given-up-${index}` });
      await db.sql`
        insert into engine_bill_reads (ledger_entry_id, organization_id, attempts, next_read_at, given_up, last_reason, updated_at)
        values (${entryId}, ${ws.organizationId}, ${MAX_BILL_READS}, null, true, 'the bill was never available', ${new Date(NOW_MS).toISOString()}::timestamptz)
      `;
    }
    const newer = await heldCall(ws.organizationId, reservationId, { at: OLD, key: "crowd:newer", providerRef: "gen-billed-1" });
    const fake = fakeReader(billedAnswer);

    const first = await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.deepEqual(first.settled.ids, [newer], "the newer call is read and settled in the first run");
    assert.deepEqual(fake.reads, ["gen-billed-1"], "only the newer call is read: no given-up or no-ref call asks a provider");
    assert.equal(first.givenUp.count, HOLD_BATCH_LIMIT, "the no-ref calls are given up in batches of the batch limit");
    assert.equal(first.needsOperator.count, HOLD_BATCH_LIMIT);

    const second = await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.equal(second.givenUp.count, noRef.length - HOLD_BATCH_LIMIT, "the rest of the no-ref calls are given up on the next run");
    assert.equal(second.needsOperator.count, noRef.length, "the operator count is the total of unsettled no-ref calls");
    assert.deepEqual(fake.reads, ["gen-billed-1"]);
    for (const entryId of noRef) {
      assert.equal((await ledgerOf(entryId)).settlement, null, "a no-ref call is never settled here");
    }
  });

  it("a successful read settles the call through the ledger and deletes its tracking row, and the settled call is never read again", async () => {
    const ws = await workspace("settle");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "settle:1", providerRef: "gen-billed-1" });
    const first = fakeReader(() => UNAVAILABLE);
    await runAt(ws.organizationId, NOW_MS, first.reader);
    const tracked = await requireTracking(entryId);
    assert.equal(tracked.attempts, 1);

    const billing = fakeReader(billedAnswer);
    const settling = await runAt(ws.organizationId, tracked.nextReadAt, billing.reader);
    assert.deepEqual(settling.settled.ids, [entryId]);
    assert.equal(settling.stillOpen.count, 0);
    const ledger = await ledgerOf(entryId);
    assert.equal(ledger.settlement, "billed");
    assert.equal(ledger.actualUsd, 0.0031, "settled to the bill, not to the 0.02 estimate");
    assert.equal(ledger.providerRef, "gen-billed-1", "tracking does not change the ledger's provider ref");
    assert.equal(await trackingOf(entryId), null, "the tracking row is deleted with the settlement");

    await runAt(ws.organizationId, tracked.nextReadAt + 400 * DAY_MS, billing.reader);
    assert.deepEqual(billing.reads, ["gen-billed-1"], "the settled call is never read again");
    assert.equal((await ledgerOf(entryId)).actualUsd, 0.0031);
  });

  it("a reader that throws is counted as a failed read, and the run goes on to the other calls", async () => {
    const ws = await workspace("throws");
    const reservationId = await reservationFor(ws);
    const failing = await heldCall(ws.organizationId, reservationId, { at: OLD, key: "throws:1", providerRef: "gen-broken-1" });
    const working = await heldCall(ws.organizationId, reservationId, { at: OLD, key: "throws:2", providerRef: "gen-billed-1" });
    const fake = fakeReader((providerRef) => {
      if (providerRef === "gen-broken-1") throw new Error("the stats endpoint reset the connection");
      return billedAnswer(providerRef);
    });

    const result = await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.deepEqual(result.settled.ids, [working]);
    assert.deepEqual(result.stillOpen.ids, [failing]);
    assert.equal(result.stillOpen.reasons[0]?.reason, "the bill read failed: the stats endpoint reset the connection");

    const tracked = await requireTracking(failing);
    assert.equal(tracked.attempts, 1, "the throw is one failed read");
    assert.equal(tracked.lastReason, "the bill read failed: the stats endpoint reset the connection");
    assert.equal(tracked.nextReadAt, NOW_MS + BILL_READ_BACKOFF_MS[0]);
    assert.equal((await ledgerOf(failing)).settlement, null, "the failed call is not changed");
    assert.equal(await trackingOf(working), null, "the settled call has no tracking row");
  });

  it("a call that succeeds after two failures settles, and its attempt count is gone", async () => {
    const ws = await workspace("twice");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "twice:1", providerRef: "gen-billed-2" });
    const fake = fakeReader((providerRef, nth) => (nth <= 2 ? UNAVAILABLE : billedAnswer(providerRef)));

    let now = NOW_MS;
    for (let run = 0; run < 2; run += 1) {
      await runAt(ws.organizationId, now, fake.reader);
      now = (await requireTracking(entryId)).nextReadAt;
    }
    assert.equal((await requireTracking(entryId)).attempts, 2);

    const result = await runAt(ws.organizationId, now, fake.reader);
    assert.deepEqual(result.settled.ids, [entryId]);
    assert.equal(fake.readsOf("gen-billed-2"), 3);
    assert.equal(await trackingOf(entryId), null, "the attempt count is deleted with the tracking row");
    assert.equal((await ledgerOf(entryId)).actualUsd, 0.0042);
  });

  it("a call with no provider ref is given up once, with its reason, and no provider is asked", async () => {
    const ws = await workspace("noref");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "noref:1" });
    const fake = fakeReader(billedAnswer);

    const first = await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.deepEqual(first.needsOperator.ids, [entryId]);
    assert.deepEqual(first.givenUp.ids, [entryId]);
    assert.equal(fake.reads.length, 0, "nothing names the bill, so no provider is asked");
    const tracking = await trackingOf(entryId);
    assert.ok(tracking);
    assert.equal(tracking.givenUp, true);
    assert.equal(tracking.attempts, 0, "no read was made");
    assert.equal(tracking.nextReadAt, null);
    assert.equal(tracking.lastReason, NO_PROVIDER_REF_REASON);

    const second = await runAt(ws.organizationId, NOW_MS + DAY_MS, fake.reader);
    assert.equal(second.givenUp.count, 0, "it is not given up twice");
    assert.deepEqual(second.needsOperator.ids, [entryId], "it stays outstanding for the operator");
    assert.equal(fake.reads.length, 0);
  });

  it("a provider with no bill reader counts as a failed read, with its reason", async () => {
    const ws = await workspace("noreader");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "noreader:1", providerRef: "gen-billed-1" });

    const result = await runAt(ws.organizationId, NOW_MS, undefined);
    assert.deepEqual(result.stillOpen.ids, [entryId]);
    const tracked = await requireTracking(entryId);
    assert.equal(tracked.attempts, 1);
    assert.equal(tracked.lastReason, "no bill reader is wired for openrouter");
    assert.equal(tracked.nextReadAt, NOW_MS + BILL_READ_BACKOFF_MS[0]);
  });

  it("a call given up for having no provider ref is read once if it gains a ref later", async () => {
    const ws = await workspace("lateref");
    const reservationId = await reservationFor(ws);
    const key = "lateref:1";
    const entryId = await heldCall(ws.organizationId, reservationId, { at: OLD, key });
    const fake = fakeReader(billedAnswer);
    await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.equal((await trackingOf(entryId))?.givenUp, true, "given up while it has no ref");
    assert.equal(fake.reads.length, 0);

    await withReservationLedger(db.sql, ws.organizationId, reservationId, (store) =>
      reconcileCall(store, { idempotencyKey: key, providerRef: "gen-billed-1" }),
    );
    const result = await runAt(ws.organizationId, NOW_MS + HOUR_MS, fake.reader);
    assert.deepEqual(result.settled.ids, [entryId]);
    assert.deepEqual(fake.reads, ["gen-billed-1"], "read once, when the ref arrived");
    assert.equal((await ledgerOf(entryId)).actualUsd, 0.0031);
  });

  it("a call settled by another path is untracked and never read", async () => {
    const ws = await workspace("other");
    const reservationId = await reservationFor(ws);
    const key = "other:1";
    const entryId = await heldCall(ws.organizationId, reservationId, { at: OLD, key, providerRef: "gen-billed-1" });
    await runAt(ws.organizationId, NOW_MS, fakeReader(() => UNAVAILABLE).reader);
    assert.ok(await trackingOf(entryId), "the failed read is tracked");

    await withReservationLedger(db.sql, ws.organizationId, reservationId, (store) =>
      reconcileCall(store, { idempotencyKey: key, billedUsd: 0.0031 }),
    );
    const fake = fakeReader(billedAnswer);
    await runAt(ws.organizationId, NOW_MS + HOUR_MS, fake.reader);
    assert.equal(fake.reads.length, 0, "a settled call is not read");
    assert.equal(await trackingOf(entryId), null, "its tracking row is removed");
  });

  it("an overlapping run does not read a call that another run is reading", async () => {
    const ws = await workspace("overlap");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "overlap:1", providerRef: "gen-never-3" });
    let reads = 0;
    let nested: ReconcileHoldsResult | undefined;
    const reader: BillReader = async () => {
      reads += 1;
      // A second run for the same workspace starts while this read is in flight.
      if (nested === undefined) nested = await runAt(ws.organizationId, NOW_MS, reader);
      return UNAVAILABLE;
    };

    const outer = await runAt(ws.organizationId, NOW_MS, reader);
    assert.equal(reads, 1, "the call is read once, by the run that claimed it");
    assert.ok(nested);
    assert.equal(nested.stillOpen.count, 0, "the overlapping run skipped the claimed call");
    assert.equal(nested.settled.count, 0);
    assert.deepEqual(outer.stillOpen.ids, [entryId]);
    assert.equal((await requireTracking(entryId)).attempts, 1);
  });

  it("a reason longer than the table keeps is clipped in the tracking row, and the run goes on", async () => {
    const ws = await workspace("long");
    const reservationId = await reservationFor(ws);
    const longFailing = await heldCall(ws.organizationId, reservationId, { at: OLD, key: "long:1", providerRef: "gen-long-1" });
    const working = await heldCall(ws.organizationId, reservationId, { at: OLD, key: "long:2", providerRef: "gen-billed-1" });
    const longReason = "x".repeat(2000);
    const fake = fakeReader((providerRef) => (providerRef === "gen-long-1" ? { status: "unavailable", reason: longReason } : billedAnswer(providerRef)));

    const result = await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.deepEqual(result.settled.ids, [working]);
    assert.deepEqual(result.stillOpen.ids, [longFailing]);
    assert.equal((await requireTracking(longFailing)).lastReason.length, 500);
  });

  it("a read cut off by a crash after the fourth read is the last allowed read: the call is given up with it, and never read a sixth time", async () => {
    const ws = await workspace("crash-last");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "crash-last:1", providerRef: "gen-never-4" });
    await cutOffRead(ws.organizationId, entryId, MAX_BILL_READS - 1, NOW_MS - MINUTE_MS);
    const fake = fakeReader(() => UNAVAILABLE);

    const first = await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.equal(fake.reads.length, 1, "the fifth read runs once");
    assert.deepEqual(first.givenUp.ids, [entryId]);
    const tracking = await trackingOf(entryId);
    assert.equal(tracking?.attempts, MAX_BILL_READS);
    assert.equal(tracking?.givenUp, true);
    assert.equal(tracking?.nextReadAt, null);

    await runAt(ws.organizationId, NOW_MS + 400 * DAY_MS, fake.reader);
    assert.equal(fake.reads.length, 1, "no sixth read, however late the next run");
  });

  it("the claim of the last allowed read gives the call up before the provider is asked", async () => {
    const ws = await workspace("claim-last");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "claim-last:1", providerRef: "gen-never-7" });
    await cutOffRead(ws.organizationId, entryId, MAX_BILL_READS - 1, NOW_MS - MINUTE_MS);
    let seenDuringRead: Tracking | null | undefined;
    const reader: BillReader = async () => {
      seenDuringRead = await trackingOf(entryId);
      return UNAVAILABLE;
    };

    await runAt(ws.organizationId, NOW_MS, reader);
    assert.deepEqual(seenDuringRead, { attempts: MAX_BILL_READS, nextReadAt: NOW_MS + 10 * MINUTE_MS, givenUp: true, lastReason: "a bill read was in flight and did not finish" });
  });

  it("a read cut off by a crash is read again when its lease ends, and the cut-off read counts toward the limit", async () => {
    const ws = await workspace("crash-again");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "crash-again:1", providerRef: "gen-never-5" });
    await cutOffRead(ws.organizationId, entryId, 2, NOW_MS - MINUTE_MS);
    const fake = fakeReader(() => UNAVAILABLE);

    await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.equal(fake.reads.length, 1, "the call is read once its lease has ended");
    const tracked = await requireTracking(entryId);
    assert.equal(tracked.attempts, 3, "the cut-off read was the second, so this is the third");
    assert.equal(tracked.nextReadAt, NOW_MS + BILL_READ_BACKOFF_MS[2]);
  });

  it("a read in flight holds its call until its lease ends, so no run reads it in the meantime", async () => {
    const ws = await workspace("lease");
    const entryId = await heldCall(ws.organizationId, await reservationFor(ws), { at: OLD, key: "lease:1", providerRef: "gen-never-6" });
    await cutOffRead(ws.organizationId, entryId, 1, NOW_MS + 5 * MINUTE_MS);
    const fake = fakeReader(() => UNAVAILABLE);

    await runAt(ws.organizationId, NOW_MS, fake.reader);
    assert.equal(fake.reads.length, 0, "the lease has not ended");
    await runAt(ws.organizationId, NOW_MS + 5 * MINUTE_MS, fake.reader);
    assert.equal(fake.reads.length, 1, "read once the lease has ended");
  });
});
