// The brief path's admission at the budget line (owner direction 2026-10-23, decision D12: a budget is a line, not a tolerance). The file
// keeps its name from the tolerance it replaced. A hold above a budget is held with a note, never paused or refused, and a call starts only
// while its line is below the budget. The rest of the reservation rules are in reserve.test.ts and preflight.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURE_IDS as ID, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { reserveFixed, extendReservation } from "./preflight.ts";
import { authorizeCall, reserve, type CallInput, type ReserveInput } from "./reserve.ts";
import { memoryLedgerStore } from "./store.ts";

const NOW = "2026-10-13T09:00:00.000Z";
const RESERVED = 0.9595; // scenePlanFixture: the estimate and the redo allowance

function input(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return { requestId: ID.request, workspaceId: "ws_fixture", mode: "cap", plan: scenePlanFixture, requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100, now: NOW, ...overrides };
}

function call(overrides: Partial<CallInput> = {}): CallInput {
  return { reservationId: ID.reservation, stage: "produce_shot", provider: "openrouter", model: "seedance-2.0-mini", estimateUsd: 0.2, idempotencyKey: "produce:shot_3:1", at: "2026-10-13T09:01:00.000Z", ...overrides };
}

test("a plan one cent above the request budget is held with a note, and its calls are gated by the line", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: RESERVED - 0.01 }));
  assert.equal(result.reservation.state, "reserved", "a hold above a budget is not paused");
  assert.ok(result.alerts.some((alert) => alert.scope === "request"), "the estimate above its budget is noted");
  assert.equal((await authorizeCall(store, call({ estimateUsd: 0.2 }))).status, "authorized", "0.00 committed is below the line, so the call starts");
});

test("a call starts below the request budget and is refused at it, for a plan that is above the budget", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 0.5 }));
  assert.equal((await authorizeCall(store, call({ estimateUsd: 0.2, idempotencyKey: "produce:shot_1:1" }))).status, "authorized");
  const second = await authorizeCall(store, call({ estimateUsd: 0.4, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(second.status, "authorized", "0.20 committed is below the 0.50 line, so the call starts");
  if (second.status === "authorized") {
    assert.ok(second.alerts.some((alert) => alert.scope === "request"), "the call takes the request past its budget, and that is recorded");
  }
  const refused = await authorizeCall(store, call({ estimateUsd: 0.2, idempotencyKey: "produce:shot_3:1" }));
  assert.equal(refused.status, "refused", "0.60 committed is at or past the 0.50 line");
  assert.equal((await store.listEntries(ID.reservation)).length, 2, "the refused call records nothing");
});

test("a row stored with the retired allowance fields keeps its line at the budget: the allowance does not widen it", async () => {
  const store = memoryLedgerStore();
  const reserved = await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  // A row written before contract v11 carries its allowance: the budget of 1.00 plus a tolerance of 0.25.
  await store.updateReservation({ ...reserved.reservation, requestAllowanceUsd: 1.25 });
  assert.equal((await authorizeCall(store, call({ estimateUsd: 1.1 }))).status, "authorized", "0.00 committed is below the 1.00 line");
  const refused = await authorizeCall(store, call({ estimateUsd: 0.1, idempotencyKey: "produce:shot_4:1" }));
  assert.equal(refused.status, "refused", "1.10 committed is past the 1.00 line, although it is inside the old allowance of 1.25");
});

test("the pre-flight hold above a budget is held with a note, not paused, at intake", async () => {
  const over = await reserveFixed(memoryLedgerStore(), {
    requestId: ID.request,
    workspaceId: "ws_fixture",
    mode: "cap",
    requestBudgetUsd: 0.5,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    reservationId: ID.reservation,
  });
  assert.equal(over.reservation.state, "reserved", "0.52 held against a budget of 0.50 is above it, and that is a note");
  assert.equal(over.alerts[0]?.scope, "request");

  const far = await reserveFixed(memoryLedgerStore(), {
    requestId: ID.request,
    workspaceId: "ws_fixture",
    mode: "cap",
    requestBudgetUsd: 0.2,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    reservationId: ID.reservation,
  });
  assert.equal(far.reservation.state, "reserved", "0.52 held against 0.20 is still held: calls are gated by the line");
  assert.equal(far.reservation.reservedUsd, 0.52);
});

test("the extension above a budget is written with a note, and keeps no allowance", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, { requestId: ID.request, workspaceId: "ws_fixture", mode: "cap", requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100, now: NOW, reservationId: ID.reservation });
  const extended = await extendReservation(store, { reservationId: ID.reservation, plan: scenePlanFixture, requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100, now: NOW });
  assert.equal(extended.status, "extended");
  if (extended.status === "extended") assert.deepEqual(extended.alerts, []);

  const above = await extendReservation(store, { reservationId: ID.reservation, plan: scenePlanFixture, requestBudgetUsd: 0.5, workspaceMonthBudgetUsd: 100, now: NOW });
  assert.equal(above.status, "extended", "a plan of 0.96 against a 0.50 budget is written, and the note says so");
  if (above.status !== "extended") return;
  assert.equal(above.alerts[0]?.scope, "request");
  assert.equal(above.reservation.reservedUsd, RESERVED);
  assert.equal("requestAllowanceUsd" in above.reservation, false);
  assert.equal("workspaceMonthAllowanceUsd" in above.reservation, false);
});
