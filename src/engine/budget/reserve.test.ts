import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type BudgetMode, type ScenePlan } from "../contracts/index.ts";
import { FIXTURE_IDS as ID, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { UnknownPriceError } from "./estimate.ts";
import { authorizeCall, reserve, type CallInput, type ReserveInput } from "./reserve.ts";
import { memoryLedgerStore, type LedgerStore } from "./store.ts";

const NOW = "2026-10-13T09:00:00.000Z";
const RESERVED = 0.9595; // scenePlanFixture: estimate 0.8716 + redo allowance 0.0879

function input(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    requestId: ID.request,
    workspaceId: "ws_fixture",
    mode: "cap",
    plan: scenePlanFixture,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    ...overrides,
  };
}

function call(overrides: Partial<CallInput> = {}): CallInput {
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

test("a reservation inside both budgets is reserved, with the plan's estimate plus the redo allowance", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation }));
  assert.equal(result.created, true);
  assert.equal(result.reservation.state, "reserved");
  assert.equal(result.reservation.reservedUsd, RESERVED);
  assert.equal(result.reservation.pausedReason, undefined);
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(await store.getReservation(ID.reservation), result.reservation);
});

test("reserving again with the same reservation id returns the first reservation and stores nothing new", async () => {
  const store = memoryLedgerStore();
  const first = await reserve(store, input({ reservationId: ID.reservation }));
  const again = await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 0.01 }));
  assert.equal(again.created, false);
  assert.deepEqual(again.reservation, first.reservation);
  assert.equal(again.reservation.state, "reserved");
});

test("a request whose reservation exceeds its budget is paused with a reason, not an exception", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "paused");
  assert.match(result.reservation.pausedReason ?? "", /request budget 0.5 USD/);
  assert.equal(result.reservation.reservedUsd, RESERVED, "a paused reservation says what it would hold");
  assert.equal((await store.getReservation(ID.reservation))?.state, "paused");
});

test("a workspace whose month would be exceeded is paused with the monthly reason", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 1 }));
  const second = await reserve(store, input({ reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W2X", workspaceMonthBudgetUsd: 1 }));
  assert.equal(second.reservation.state, "paused");
  assert.match(second.reservation.pausedReason ?? "", /workspace monthly budget 1 USD/);
});

test("both budgets exceeded in one reservation give both reasons", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ requestBudgetUsd: 0.5, workspaceMonthBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "paused");
  assert.match(result.reservation.pausedReason ?? "", /request budget.*; workspace monthly budget/);
});

test("paused reservations do not count against the workspace month", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ requestBudgetUsd: 0.5 }));
  const next = await reserve(store, input({ workspaceMonthBudgetUsd: RESERVED }));
  assert.equal(next.reservation.state, "reserved");
});

test("reservations from an earlier month do not count against this month", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ now: "2026-09-30T23:00:00.000Z" }));
  const october = await reserve(store, input({ now: "2026-10-01T01:00:00.000Z", workspaceMonthBudgetUsd: RESERVED }));
  assert.equal(october.reservation.state, "reserved");
});

test("warn mode records an over-budget reservation as reserved and returns an overrun alert", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ mode: "warn", requestBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "reserved");
  assert.equal(result.reservation.pausedReason, undefined);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].kind, "overrun");
  assert.equal(result.alerts[0].scope, "request");
});

test("observe mode records an over-budget reservation silently", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ mode: "observe", requestBudgetUsd: 0.5, workspaceMonthBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "reserved");
  assert.deepEqual(result.alerts, []);
});

test("an unknown price stops the reservation with a typed error, and nothing is stored", async () => {
  const store = memoryLedgerStore();
  const unknown: ScenePlan = structuredClone(scenePlanFixture);
  unknown.shots[2] = {
    ...unknown.shots[2],
    source: { kind: "generate", modelClass: "video.i2v_pinned", prompt: "A pinned frame move.", refs: [], takes: 1 },
  };
  await assert.rejects(reserve(store, input({ plan: unknown, reservationId: ID.reservation })), UnknownPriceError);
  assert.equal(await store.getReservation(ID.reservation), null);
  assert.deepEqual(await store.sumForMonth("ws_fixture", "2026-10"), { reservedUsd: 0, actualUsd: 0 });
});

test("cap refuses a call that would take the reservation beyond its amount, and records nothing", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  const refused = await authorizeCall(store, call({ estimateUsd: RESERVED + 0.01 }));
  assert.equal(refused.status, "refused");
  assert.match(refused.status === "refused" ? refused.reason : "", /above its/);
  assert.equal(refused.status === "refused" ? refused.alerts[0].scope : "", "call");
  assert.deepEqual(await store.listEntries(ID.reservation), []);
});

test("an authorized call is recorded with its estimate and its hold, and the reservation is unchanged", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  const result = await authorizeCall(store, call({ entryId: ID.ledgerShot3 }));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.equal(result.entry.entryId, ID.ledgerShot3);
  assert.equal(result.entry.reservedUsd, 0.2016);
  assert.equal(result.entry.actualUsd, undefined);
  assert.equal(result.entry.workspaceId, "ws_fixture");
  assert.equal(result.entry.reservationId, ID.reservation);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, RESERVED);
});

test("a duplicate idempotency key returns the existing entry and never bills twice", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  const first = await authorizeCall(store, call());
  const second = await authorizeCall(store, call({ entryId: "led_01J9ZK3M4N5P6Q7R8S9T0V1W2X" }));
  assert.equal(first.status, "authorized");
  assert.equal(second.status, "duplicate");
  if (second.status !== "duplicate" || first.status !== "authorized") return;
  assert.equal(second.entry.entryId, first.entry.entryId);
  assert.equal(second.samePayload, true);
  assert.equal((await store.listEntries(ID.reservation)).length, 1);
  assert.equal((await store.sumForMonth("ws_fixture", "2026-10")).reservedUsd, RESERVED);
});

test("a duplicate key with a different payload is returned as the original, flagged as not the same payload", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  await authorizeCall(store, call());
  const changed = await authorizeCall(store, call({ estimateUsd: 0.5 }));
  assert.equal(changed.status, "duplicate");
  if (changed.status !== "duplicate") return;
  assert.equal(changed.samePayload, false);
  assert.equal(changed.entry.estimateUsd, 0.2016);
});

test("two concurrent calls with the same key produce one entry and one bill", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 100 }));
  const [a, b] = await Promise.all([
    authorizeCall(store, call({ estimateUsd: 0.9 })),
    authorizeCall(store, call({ estimateUsd: 0.9, entryId: "led_01J9ZK3M4N5P6Q7R8S9T0V1W2X" })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["authorized", "duplicate"]);
  assert.equal((await store.listEntries(ID.reservation)).length, 1);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, RESERVED);
});

test("a call against a paused reservation is refused, and a call against a missing one is an error", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 0.5 }));
  const refused = await authorizeCall(store, call());
  assert.equal(refused.status, "refused");
  assert.match(refused.status === "refused" ? refused.reason : "", /paused/);
  await assert.rejects(
    authorizeCall(store, call({ reservationId: "res_01J9ZK3M4N5P6Q7R8S9T0V1W2Y" })),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
});

test("an empty idempotency key is refused", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  await assert.rejects(authorizeCall(store, call({ idempotencyKey: "" })), EngineError);
});

test("warn mode authorizes an overrunning call with an alert and raises the reservation", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, mode: "warn" }));
  const result = await authorizeCall(store, call({ estimateUsd: 1 }));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.equal(result.alerts.length, 1);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, 1);
});

test("observe mode authorizes an overrunning call silently and still raises the reservation", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, mode: "observe" }));
  const result = await authorizeCall(store, call({ estimateUsd: 1 }));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.deepEqual(result.alerts, []);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, 1);
});

test("every mode is a value the reservation accepts", async () => {
  const modes: BudgetMode[] = ["observe", "warn", "cap"];
  for (const mode of modes) {
    const store: LedgerStore = memoryLedgerStore();
    const result = await reserve(store, input({ mode }));
    assert.equal(result.reservation.mode, mode);
  }
});
