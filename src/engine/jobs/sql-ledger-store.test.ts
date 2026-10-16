import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { budgetReservationSchema, EngineError, ledgerEntrySchema } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId, fixtures } from "../contracts/fixtures/index.ts";
import { authorizeCall, reserve, type CallInput, type ReserveInput } from "../budget/reserve.ts";
import { reconcileCall } from "../budget/reconcile.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { withReservationLedger, withWorkspaceLedger } from "./sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

let db: TestDatabase;
const NOW = "2026-10-13T09:00:00.000Z";

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

/** A workspace with one request, so reservations and entries have the parent rows the foreign keys need. */
async function workspace(n: number): Promise<{ organizationId: string; requestId: string }> {
  const organizationId = `ws_ledger_${n}`;
  const requestId = fixtureId("req_", 700 + n);
  await seedWorkspace(db.sql, organizationId);
  await db.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, state)
    values (${requestId}, ${organizationId}, 'fmt_ledger', 'normal', 'running', '{}')
  `;
  return { organizationId, requestId };
}

function reserveInput(organizationId: string, requestId: string, overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    requestId,
    workspaceId: organizationId,
    mode: "cap",
    plan: fixtures.scenePlan,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    ...overrides,
  };
}

function callInput(reservationId: string, overrides: Partial<CallInput> = {}): CallInput {
  return {
    reservationId,
    stage: "produce_shot",
    provider: "openrouter",
    model: "seedance-2.0-mini",
    estimateUsd: 0.2016,
    idempotencyKey: `produce:${fixtureId("shot_", 3)}:1`,
    at: "2026-10-13T09:01:00.000Z",
    ...overrides,
  };
}

test("a reservation over the request budget in cap mode is stored paused, with its reason, and holds nothing", async () => {
  const { organizationId, requestId } = await workspace(1);
  const result = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId, { requestBudgetUsd: 0.5 })));
  assert.equal(result.reservation.state, "paused");
  assert.match(result.reservation.pausedReason ?? "", /request budget/);
  assert.equal(result.alerts[0]?.scope, "request");
  const stored = await withReservationLedger(db.sql, organizationId, result.reservation.reservationId, async (store) => store.getReservation(result.reservation.reservationId));
  assert.deepEqual(budgetReservationSchema.parse(stored), stored, "a stored reservation reads back as its contract");
  assert.equal(stored?.state, "paused");
  assert.equal(stored?.pausedReason, result.reservation.pausedReason);
});

test("a reservation inside both budgets is reserved; a call is booked once; a duplicate key returns the first entry and bills nothing twice", async () => {
  const { organizationId, requestId } = await workspace(2);
  const reserved = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId)));
  assert.equal(reserved.reservation.state, "reserved");
  assert.equal(reserved.reservation.reservedUsd, 0.9595);
  const id = reserved.reservation.reservationId;

  const first = await withReservationLedger(db.sql, organizationId, id, (store) => authorizeCall(store, callInput(id)));
  assert.equal(first.status, "authorized");
  const second = await withReservationLedger(db.sql, organizationId, id, (store) => authorizeCall(store, callInput(id, { entryId: fixtureId("led_", 720) })));
  assert.equal(second.status, "duplicate");
  if (second.status === "duplicate") assert.equal(second.samePayload, true);
  const entries = await withReservationLedger(db.sql, organizationId, id, (store) => store.listEntries(id));
  assert.equal(entries.length, 1, "the duplicate key stored nothing new");
  assert.equal(ledgerEntrySchema.safeParse(entries[0]).success, true, "the stored entry reads back as the LedgerEntry contract");
});

test("a call that would take a cap-mode reservation above its amount is refused, and records nothing", async () => {
  const { organizationId, requestId } = await workspace(3);
  const reserved = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId)));
  const id = reserved.reservation.reservationId;
  const refused = await withReservationLedger(db.sql, organizationId, id, (store) => authorizeCall(store, callInput(id, { estimateUsd: 5, idempotencyKey: "too-big" })));
  assert.equal(refused.status, "refused");
  const entries = await withReservationLedger(db.sql, organizationId, id, (store) => store.listEntries(id));
  assert.equal(entries.length, 0);
});

test("a call on a paused reservation is refused, and no entry is written", async () => {
  const { organizationId, requestId } = await workspace(4);
  const paused = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId, { requestBudgetUsd: 0.1 })));
  const id = paused.reservation.reservationId;
  const result = await withReservationLedger(db.sql, organizationId, id, (store) => authorizeCall(store, callInput(id, { idempotencyKey: "paused-call" })));
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.match(result.reason, /paused/);
  assert.equal((await withReservationLedger(db.sql, organizationId, id, (store) => store.listEntries(id))).length, 0);
});

test("reconciling a call twice keeps the first actual, and releasing returns the unused part once", async () => {
  const { organizationId, requestId } = await workspace(5);
  const reserved = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId)));
  const id = reserved.reservation.reservationId;
  await withReservationLedger(db.sql, organizationId, id, (store) => authorizeCall(store, callInput(id, { idempotencyKey: "reconcile-me" })));

  const one = await withReservationLedger(db.sql, organizationId, id, (store) => reconcileCall(store, { idempotencyKey: "reconcile-me", billedUsd: 0.19 }));
  assert.equal(one.entry.actualUsd, 0.19);
  const two = await withReservationLedger(db.sql, organizationId, id, (store) => reconcileCall(store, { idempotencyKey: "reconcile-me", billedUsd: 0.5 }));
  assert.equal(two.entry.actualUsd, 0.19, "the first actual stands");

  const released = await withReservationLedger(db.sql, organizationId, id, (store) => releaseReservation(store, id));
  assert.equal(released.reservation.state, "released");
  assert.equal(released.reservation.reservedUsd, 0.19, "the reservation shrinks to what was committed");
  assert.equal(released.releasedUsd, 0.7695);
  const again = await withReservationLedger(db.sql, organizationId, id, (store) => releaseReservation(store, id));
  assert.equal(again.releasedUsd, 0, "releasing twice changes nothing");
});

test("the month totals count each workspace's reservations (not paused ones) and actuals", async () => {
  const { organizationId, requestId } = await workspace(6);
  await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId)));
  await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId, { requestBudgetUsd: 0.1 })));
  const totals = await withWorkspaceLedger(db.sql, organizationId, (store) => store.sumForMonth(organizationId, "2026-10"));
  assert.deepEqual(totals, { reservedUsd: 0.9595, actualUsd: 0 });
  await seedWorkspace(db.sql, "ws_ledger_other");
  const other = await withWorkspaceLedger(db.sql, "ws_ledger_other", (store) => store.sumForMonth("ws_ledger_other", "2026-10"));
  assert.deepEqual(other, { reservedUsd: 0, actualUsd: 0 }, "another workspace is not counted");
  await assert.rejects(
    withWorkspaceLedger(db.sql, organizationId, (store) => store.sumForMonth("ws_ledger_other", "2026-10")),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    "a store cannot read another workspace's totals",
  );
});

test("the database refuses a second entry with the same idempotency key in one workspace", async () => {
  const { organizationId, requestId } = await workspace(7);
  const reserved = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId)));
  const id = reserved.reservation.reservationId;
  await db.sql`
    insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, idempotency_key, at)
    values (${fixtureId("led_", 730)}, ${organizationId}, ${requestId}, ${id}, 'render', 'p', 'm', 0.05, 0.05, 'same-key', now())
  `;
  await assert.rejects(
    db.sql`
      insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, idempotency_key, at)
      values (${fixtureId("led_", 731)}, ${organizationId}, ${requestId}, ${id}, 'render', 'p', 'm', 0.05, 0.05, 'same-key', now())
    `,
    /unique|duplicate/i,
  );
});

test("a store refuses a reservation or entry that belongs to another workspace, and a reservation from another workspace is not found", async () => {
  const { organizationId, requestId } = await workspace(8);
  const reserved = await withWorkspaceLedger(db.sql, organizationId, (store) => reserve(store, reserveInput(organizationId, requestId)));
  await withWorkspaceLedger(db.sql, organizationId, async (store) => {
    await assert.rejects(
      store.createReservation({ ...reserved.reservation, reservationId: FIXTURE_IDS.reservation, workspaceId: "ws_elsewhere" }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
  await assert.rejects(
    withReservationLedger(db.sql, "ws_elsewhere", reserved.reservation.reservationId, async () => "never"),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
});
