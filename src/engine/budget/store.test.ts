import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type BudgetReservation } from "../contracts/index.ts";
import { budgetReservationFixture, FIXTURE_IDS as ID, ledgerRenderFixture } from "../contracts/fixtures/index.ts";
import { memoryLedgerStore, type LedgerRow } from "./store.ts";

/** A row that has no actual unless the test gives one. */
function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ...ledgerRenderFixture,
    actualUsd: undefined,
    entryId: ID.ledgerRender,
    reservationId: ID.reservation,
    workspaceId: "ws_fixture",
    idempotencyKey: "render:one",
    ...overrides,
  };
}

function reservation(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return { ...budgetReservationFixture, ...overrides };
}

test("a stored reservation is a copy: changing the value a caller holds does not change the store", async () => {
  const store = memoryLedgerStore();
  await store.createReservation(reservation());
  const fetched = await store.getReservation(ID.reservation);
  assert.ok(fetched);
  fetched.reservedUsd = 999;
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, budgetReservationFixture.reservedUsd);
});

test("creating a reservation whose id exists is a conflict", async () => {
  const store = memoryLedgerStore();
  await store.createReservation(reservation());
  await assert.rejects(
    store.createReservation(reservation()),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
  );
});

test("updating a reservation that does not exist is not_found, and an update replaces the stored value", async () => {
  const store = memoryLedgerStore();
  await assert.rejects(
    store.updateReservation(reservation()),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
  await store.createReservation(reservation());
  await store.updateReservation(reservation({ reservedUsd: 0.5 }));
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, 0.5);
});

test("appending an entry whose key exists returns the existing entry and stores nothing new", async () => {
  const store = memoryLedgerStore();
  const first = await store.appendEntry(row());
  const second = await store.appendEntry(row({ entryId: "led_01J9ZK3M4N5P6Q7R8S9T0V1W2X", estimateUsd: 9 }));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.entry.entryId, ID.ledgerRender);
  assert.equal((await store.listEntries(ID.reservation)).length, 1);
});

test("setting an actual on an entry that does not exist is not_found", async () => {
  const store = memoryLedgerStore();
  await assert.rejects(
    store.settle(ID.ledgerRender, { actualUsd: 1, settlement: "billed" }),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
});

test("sumForMonth adds one workspace's reservations and actuals in one month, leaving out paused reservations", async () => {
  const store = memoryLedgerStore();
  await store.createReservation(reservation({ reservationId: ID.reservation, reservedUsd: 0.5, createdAt: "2026-10-02T10:00:00.000Z" }));
  await store.createReservation(reservation({ reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W2X", reservedUsd: 0.25, createdAt: "2026-10-20T10:00:00.000Z" }));
  await store.createReservation(
    reservation({
      reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W2Y",
      reservedUsd: 3,
      state: "paused",
      pausedReason: "over budget",
      createdAt: "2026-10-03T10:00:00.000Z",
    }),
  );
  await store.createReservation(reservation({ reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W2Z", workspaceId: "ws_other", reservedUsd: 7, createdAt: "2026-10-04T10:00:00.000Z" }));
  await store.createReservation(reservation({ reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W3A", reservedUsd: 2, createdAt: "2026-09-30T10:00:00.000Z" }));

  await store.appendEntry(row({ entryId: ID.ledgerRender, idempotencyKey: "a", actualUsd: 0.047, at: "2026-10-05T10:00:00.000Z" }));
  await store.appendEntry(row({ entryId: ID.ledgerStt, idempotencyKey: "b", actualUsd: 0.02, at: "2026-11-01T10:00:00.000Z" }));
  await store.appendEntry(row({ entryId: ID.ledgerShot3, idempotencyKey: "c", workspaceId: "ws_other", actualUsd: 5, at: "2026-10-05T10:00:00.000Z" }));
  await store.appendEntry(row({ entryId: "led_01J9ZK3M4N5P6Q7R8S9T0V1W3B", idempotencyKey: "d", at: "2026-10-06T10:00:00.000Z" }));

  assert.deepEqual(await store.sumForMonth("ws_fixture", "2026-10"), { reservedUsd: 0.75, actualUsd: 0.047 });
  assert.deepEqual(await store.sumForMonth("ws_fixture", "2026-11"), { reservedUsd: 0, actualUsd: 0.02 });
  assert.deepEqual(await store.sumForMonth("ws_nobody", "2026-10"), { reservedUsd: 0, actualUsd: 0 });
});
