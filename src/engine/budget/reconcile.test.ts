import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "../contracts/index.ts";
import { FIXTURE_IDS as ID, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { authorizeCall, reserve, type CallInput, type ReserveInput } from "./reserve.ts";
import { releaseReservation, reconcileCall } from "./reconcile.ts";
import { memoryLedgerStore, type LedgerStore } from "./store.ts";

function reserveInput(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    requestId: ID.request,
    workspaceId: "ws_fixture",
    mode: "cap",
    plan: scenePlanFixture,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: "2026-10-13T09:00:00.000Z",
    reservationId: ID.reservation,
    ...overrides,
  };
}

function callInput(overrides: Partial<CallInput> = {}): CallInput {
  return {
    reservationId: ID.reservation,
    stage: "produce_shot",
    provider: "openrouter",
    model: "seedance-2.0-mini",
    estimateUsd: 0.2016,
    idempotencyKey: "produce:shot_3:1",
    at: "2026-10-13T09:01:00.000Z",
    ...overrides,
  };
}

async function reservedWithOneCall(mode: "observe" | "warn" | "cap" = "cap"): Promise<LedgerStore> {
  const store = memoryLedgerStore();
  await reserve(store, reserveInput({ mode }));
  const authorized = await authorizeCall(store, callInput());
  assert.equal(authorized.status, "authorized");
  return store;
}

test("a bill from the provider is recorded as the actual, and is not flagged as an estimate", async () => {
  const store = await reservedWithOneCall();
  const result = await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", actualUsd: 0.19 });
  assert.equal(result.entry.actualUsd, 0.19);
  assert.equal(result.entry.actualIsEstimate, false);
  assert.deepEqual(result.alerts, []);
});

test("with no bill, the adapter's list price is the actual and is flagged as an estimate", async () => {
  const store = await reservedWithOneCall();
  const result = await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", listPriceUsd: 0.2016 });
  assert.equal(result.entry.actualUsd, 0.2016);
  assert.equal(result.entry.actualIsEstimate, true);
});

test("with no bill and no list price, the held amount is recorded and flagged, never 0", async () => {
  const store = await reservedWithOneCall();
  const result = await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", listPriceUsd: null });
  assert.equal(result.entry.actualUsd, 0.2016);
  assert.equal(result.entry.actualIsEstimate, true);
});

test("reconciling a call twice keeps the first actual", async () => {
  const store = await reservedWithOneCall();
  await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", actualUsd: 0.19 });
  const again = await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", actualUsd: 0.5 });
  assert.equal(again.entry.actualUsd, 0.19);
  assert.equal((await store.listEntries(ID.reservation))[0].actualUsd, 0.19);
});

test("an unknown idempotency key is a not_found error", async () => {
  const store = memoryLedgerStore();
  await assert.rejects(
    reconcileCall(store, { idempotencyKey: "nothing" }),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
});

test("a cost above the hold raises the reservation to the committed amount and alerts in cap mode", async () => {
  const store = await reservedWithOneCall("cap");
  const result = await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", actualUsd: 1.2 });
  assert.equal(result.reservation.reservedUsd, 1.2);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, 1.2);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].scope, "call");
});

test("in observe mode a cost above the hold is recorded and the reservation raised, with no alert", async () => {
  const store = await reservedWithOneCall("observe");
  const result = await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", actualUsd: 1.2 });
  assert.equal(result.reservation.reservedUsd, 1.2);
  assert.deepEqual(result.alerts, []);
});

test("releasing a reservation returns the unused part and leaves the committed actuals", async () => {
  const store = await reservedWithOneCall();
  await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", actualUsd: 0.19 });
  const released = await releaseReservation(store, ID.reservation);
  assert.equal(released.releasedUsd, 0.7695);
  assert.equal(released.reservation.state, "released");
  assert.equal(released.reservation.reservedUsd, 0.19);
  assert.equal((await store.sumForMonth("ws_fixture", "2026-10")).reservedUsd, 0.19);
});

test("releasing keeps the hold of a call that has not been reconciled yet", async () => {
  const store = await reservedWithOneCall();
  const released = await releaseReservation(store, ID.reservation);
  assert.equal(released.releasedUsd, 0.7579);
  assert.equal(released.reservation.reservedUsd, 0.2016);
});

test("releasing twice is a no-op the second time, and releasing a paused reservation releases nothing", async () => {
  const store = await reservedWithOneCall();
  await releaseReservation(store, ID.reservation);
  const second = await releaseReservation(store, ID.reservation);
  assert.equal(second.releasedUsd, 0);

  const paused = memoryLedgerStore();
  await reserve(paused, reserveInput({ requestBudgetUsd: 0.5, reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W2X" }));
  const none = await releaseReservation(paused, "res_01J9ZK3M4N5P6Q7R8S9T0V1W2X");
  assert.equal(none.releasedUsd, 0);
  assert.equal(none.reservation.state, "paused");
});

test("releasing an unknown reservation is a not_found error", async () => {
  await assert.rejects(
    releaseReservation(memoryLedgerStore(), ID.reservation),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
});

test("the whole flow reserves, authorizes, reconciles and releases, and the monthly total follows the actuals", async () => {
  const store = memoryLedgerStore();
  await reserve(store, reserveInput());
  await authorizeCall(store, callInput({ idempotencyKey: "voice:1", stage: "voice", estimateUsd: 0.02, provider: "fixture-stt", model: "word-timestamps" }));
  await authorizeCall(store, callInput({ idempotencyKey: "produce:shot_3:1" }));
  await reconcileCall(store, { idempotencyKey: "voice:1", actualUsd: 0.02 });
  await reconcileCall(store, { idempotencyKey: "produce:shot_3:1", listPriceUsd: 0.2016 });
  const released = await releaseReservation(store, ID.reservation);
  assert.equal(released.reservation.reservedUsd, 0.2216);
  assert.equal(released.releasedUsd, 0.7379);
  const month = await store.sumForMonth("ws_fixture", "2026-10");
  assert.equal(month.reservedUsd, 0.2216);
  assert.equal(month.actualUsd, 0.2216);
});
