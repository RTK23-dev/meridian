// The provider ref of a paid call (contract v9) and the reconciler of held calls (budget/reconcile-holds.ts), on the ledger's own store
// (PGlite or Postgres through the test database) and on the memory store. Bills are recorded fixtures: no live API is called.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { budgetReservationSchema, EngineError, newId } from "../contracts/index.ts";
import { authorizeCall, type CallInput } from "./reserve.ts";
import { reconcileCall } from "./reconcile.ts";
import { reconcileHolds, HOLD_SETTLE_AFTER_MS, type BillReader } from "./reconcile-holds.ts";
import { memoryLedgerStore } from "./store.ts";
import { withReservationLedger, withWorkspaceLedger } from "../jobs/sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

const NOW_MS = Date.parse("2026-10-17T10:00:00.000Z");
/** An hour before now: older than the settle-after age. */
const OLD = "2026-10-17T09:00:00.000Z";
/** Two minutes before now: younger than the settle-after age, so it is left alone. */
const YOUNG = "2026-10-17T09:58:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

/** A workspace with one request, so that its reservations and entries have the parent rows the foreign keys need. */
async function workspace(label: string): Promise<{ organizationId: string; requestId: string }> {
  const organizationId = `ws_holds_${label}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const requestId = newId("req_");
  await seedWorkspace(db.sql, organizationId);
  await db.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, state)
    values (${requestId}, ${organizationId}, 'fmt_holds', 'normal', 'running', '{}')
  `;
  return { organizationId, requestId };
}

async function reservationFor(organizationId: string, requestId: string): Promise<string> {
  const reservationId = newId("res_");
  const reservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId,
    requestId,
    workspaceId: organizationId,
    mode: "cap",
    lines: [{ stage: "voice", estimateUsd: 1 }],
    estimateUsd: 1,
    redoAllowanceUsd: 0,
    reservedUsd: 1,
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

async function rowOf(entryId: string): Promise<{ settlement: string | null; actual_usd: string | number | null; provider_ref: string | null }> {
  const rows = await db.sql<{ settlement: string | null; actual_usd: string | number | null; provider_ref: string | null }>`
    select settlement, actual_usd, provider_ref from engine_ledger where id = ${entryId}
  `;
  const row = rows[0];
  assert.ok(row, `ledger row ${entryId} exists`);
  return row;
}

/** Bills of the recorded fixtures: a finished generation with its cost, and one whose stats have not arrived. */
const BILLS: Record<string, number> = { "gen-billed-1": 0.0031, "gen-second-1": 0.0042 };

/** A bill reader over BILLS. Every call is recorded, so a test can see which calls were read. */
function billReader(calls: Array<{ organizationId: string; providerRef: string }> = []): BillReader {
  return async (input) => {
    calls.push(input);
    const usd = BILLS[input.providerRef];
    return usd === undefined ? { status: "unavailable", reason: "the generation stats have not arrived" } : { status: "billed", usd };
  };
}

describe("the provider ref of a paid call (contract v9)", () => {
  it("a memory ledger records a call's provider ref while the call is held, refuses a different one, and keeps it through the bill", async () => {
    const store = memoryLedgerStore();
    const reservation = budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: newId("res_"),
      requestId: newId("req_"),
      workspaceId: "ws_memory",
      mode: "cap",
      lines: [{ stage: "voice", estimateUsd: 1 }],
      estimateUsd: 1,
      redoAllowanceUsd: 0,
      reservedUsd: 1,
      state: "reserved",
      createdAt: "2026-10-17T08:00:00.000Z",
    });
    await store.createReservation(reservation);
    const key = "tts:memory:1";
    const authorized = await authorizeCall(store, {
      reservationId: reservation.reservationId,
      stage: "voice",
      provider: "openrouter",
      model: "elevenlabs/eleven-v4",
      estimateUsd: 0.02,
      idempotencyKey: key,
      at: OLD,
    });
    assert.equal(authorized.status, "authorized");
    assert.equal(authorized.entry.providerRef, null, "a call authorized before its provider names it has no ref");

    const held = await reconcileCall(store, { idempotencyKey: key, providerRef: "gen-memory-1" });
    assert.equal(held.entry.providerRef, "gen-memory-1");
    assert.equal(held.settled, false, "the ref alone settles nothing");
    assert.equal(held.entry.actualUsd, undefined);
    assert.equal((await store.getEntryByKey(key))?.providerRef, "gen-memory-1", "read back from the store");

    await reconcileCall(store, { idempotencyKey: key, providerRef: "gen-memory-1" });
    await assert.rejects(reconcileCall(store, { idempotencyKey: key, providerRef: "gen-memory-2" }), (error: unknown) => error instanceof EngineError && error.kind === "conflict");

    const billed = await reconcileCall(store, { idempotencyKey: key, billedUsd: 0.0031 });
    assert.equal(billed.settled, true);
    assert.equal(billed.entry.providerRef, "gen-memory-1", "the bill does not change the ref");
  });

  it("a provider ref is refused when it is empty or too long, before any write", async () => {
    const store = memoryLedgerStore();
    await assert.rejects(store.setProviderRef("led_missing", ""), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    await assert.rejects(store.setProviderRef("led_missing", "x".repeat(513)), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });
});

describe("the reconciler of held calls (contract v9, budget/reconcile-holds.ts)", () => {
  it("settles a held call whose bill can be read to that bill, and a second run has nothing left to settle", async () => {
    const { organizationId, requestId } = await workspace("billed");
    const reservationId = await reservationFor(organizationId, requestId);
    const entryId = await heldCall(organizationId, reservationId, { at: OLD, key: "billed:1", providerRef: "gen-billed-1" });

    const first = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: { openrouter: billReader() } });
    assert.deepEqual(first.settled.ids, [entryId]);
    assert.equal(first.stillOpen.count, 0);
    assert.equal(first.needsOperator.count, 0);
    const row = await rowOf(entryId);
    assert.equal(row.settlement, "billed");
    assert.equal(Number(row.actual_usd), 0.0031, "settled to the bill, not to the 0.02 estimate");
    assert.equal(row.provider_ref, "gen-billed-1");

    const second = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: { openrouter: billReader() } });
    assert.equal(second.settled.count, 0);
    assert.equal(Number(((await rowOf(entryId)).actual_usd)), 0.0031);
  });

  it("leaves a held call whose bill is not readable yet at its reservation, and counts it with its reason", async () => {
    const { organizationId, requestId } = await workspace("late");
    const reservationId = await reservationFor(organizationId, requestId);
    const entryId = await heldCall(organizationId, reservationId, { at: OLD, key: "late:1", providerRef: "gen-late-1" });

    const result = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: { openrouter: billReader() } });
    assert.equal(result.settled.count, 0);
    assert.deepEqual(result.stillOpen.ids, [entryId]);
    assert.equal(result.stillOpen.reasons[0]?.reason, "the generation stats have not arrived");
    const row = await rowOf(entryId);
    assert.equal(row.settlement, null, "no bill, no settlement");
    assert.equal(row.actual_usd, null);
    assert.equal(row.provider_ref, "gen-late-1", "the ref stays, so the next run can read the bill");
  });

  it("reports a held call with no provider ref for an operator, and never reads or settles it", async () => {
    const { organizationId, requestId } = await workspace("operator");
    const reservationId = await reservationFor(organizationId, requestId);
    const entryId = await heldCall(organizationId, reservationId, { at: OLD, key: "operator:1" });
    const calls: Array<{ organizationId: string; providerRef: string }> = [];

    const result = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: { openrouter: billReader(calls) } });
    assert.deepEqual(result.needsOperator.ids, [entryId]);
    assert.equal(result.settled.count, 0);
    assert.equal(calls.length, 0, "nothing names the bill, so no reader is asked");
    assert.equal((await rowOf(entryId)).settlement, null);
  });

  it("leaves a call younger than the settle-after age alone, with or without a provider ref", async () => {
    const { organizationId, requestId } = await workspace("young");
    const reservationId = await reservationFor(organizationId, requestId);
    const withRef = await heldCall(organizationId, reservationId, { at: YOUNG, key: "young:1", providerRef: "gen-billed-1" });
    const withoutRef = await heldCall(organizationId, reservationId, { at: YOUNG, key: "young:2" });
    const calls: Array<{ organizationId: string; providerRef: string }> = [];

    const result = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: { openrouter: billReader(calls) } });
    assert.equal(result.settled.count + result.stillOpen.count + result.needsOperator.count, 0);
    assert.equal(calls.length, 0);
    assert.equal((await rowOf(withRef)).settlement, null);
    assert.equal((await rowOf(withoutRef)).settlement, null);
    assert.equal(HOLD_SETTLE_AFTER_MS, 5 * 60 * 1000);
  });

  it("never reads or settles another workspace's held calls", async () => {
    const mine = await workspace("mine");
    const theirs = await workspace("theirs");
    const myReservation = await reservationFor(mine.organizationId, mine.requestId);
    const theirReservation = await reservationFor(theirs.organizationId, theirs.requestId);
    await heldCall(mine.organizationId, myReservation, { at: OLD, key: "mine:1", providerRef: "gen-second-1" });
    const theirEntry = await heldCall(theirs.organizationId, theirReservation, { at: OLD, key: "theirs:1", providerRef: "gen-billed-1" });
    const calls: Array<{ organizationId: string; providerRef: string }> = [];

    const result = await reconcileHolds(db.sql, { organizationId: mine.organizationId, now: NOW_MS, readers: { openrouter: billReader(calls) } });
    assert.equal(result.settled.count, 1);
    assert.ok(calls.every((call) => call.organizationId === mine.organizationId), "the bill is read in this workspace only");
    assert.equal(calls.some((call) => call.providerRef === "gen-billed-1"), false);
    assert.equal((await rowOf(theirEntry)).settlement, null, "another workspace's held call is untouched");
  });

  it("a bill read that throws keeps its call held, and the run goes on to the next call", async () => {
    const { organizationId, requestId } = await workspace("throws");
    const reservationId = await reservationFor(organizationId, requestId);
    const failing = await heldCall(organizationId, reservationId, { at: OLD, key: "throws:1", providerRef: "gen-broken-1" });
    const working = await heldCall(organizationId, reservationId, { at: OLD, key: "throws:2", providerRef: "gen-billed-1" });
    const reader: BillReader = async (input) => {
      if (input.providerRef === "gen-broken-1") throw new Error("the stats endpoint reset the connection");
      return billReader()(input);
    };

    const result = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: { openrouter: reader } });
    assert.deepEqual(result.settled.ids, [working]);
    assert.deepEqual(result.stillOpen.ids, [failing]);
    assert.match(result.stillOpen.reasons[0]?.reason ?? "", /the bill read failed/);
    assert.equal((await rowOf(failing)).settlement, null);
  });

  it("a held call of a provider with no reader is left held, and says so", async () => {
    const { organizationId, requestId } = await workspace("noreader");
    const reservationId = await reservationFor(organizationId, requestId);
    const entryId = await heldCall(organizationId, reservationId, { at: OLD, key: "noreader:1", providerRef: "gen-billed-1" });
    const result = await reconcileHolds(db.sql, { organizationId, now: NOW_MS, readers: {} });
    assert.deepEqual(result.stillOpen.ids, [entryId]);
    assert.match(result.stillOpen.reasons[0]?.reason ?? "", /no bill reader is wired for openrouter/);
    assert.equal((await rowOf(entryId)).settlement, null);
  });

  it("the provider ref is written and read back through the SQL store, and a different ref for the same call is refused", async () => {
    const { organizationId, requestId } = await workspace("readback");
    const reservationId = await reservationFor(organizationId, requestId);
    const key = "readback:1";
    const entryId = await heldCall(organizationId, reservationId, { at: OLD, key });
    assert.equal((await rowOf(entryId)).provider_ref, null);

    await withReservationLedger(db.sql, organizationId, reservationId, (store) => reconcileCall(store, { idempotencyKey: key, providerRef: "gen-readback-1" }));
    const readBack = await withReservationLedger(db.sql, organizationId, reservationId, (store) => store.getEntryByKey(key));
    assert.equal(readBack?.providerRef, "gen-readback-1");
    assert.equal(readBack?.entryId, entryId);

    await assert.rejects(
      withReservationLedger(db.sql, organizationId, reservationId, (store) => reconcileCall(store, { idempotencyKey: key, providerRef: "gen-readback-2" })),
      (error: unknown) => error instanceof EngineError && error.kind === "conflict",
    );
    const listed = await withReservationLedger(db.sql, organizationId, reservationId, (store) => store.listEntries(reservationId));
    assert.equal(listed[0]?.providerRef, "gen-readback-1", "the first ref is kept");
  });
});
