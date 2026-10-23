// The brief path's admission with the overrun tolerance (owner direction 2026-10-23): a small overrun is never a stop in cap mode, and only
// an overrun past an allowance pauses or refuses. The strict boundary is covered in reserve.test.ts and preflight.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURE_IDS as ID, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { allowanceUsd, type BudgetTolerance } from "./tolerance.ts";
import { reserveFixed, extendReservation } from "./preflight.ts";
import { authorizeCall, reserve, type CallInput, type ReserveInput } from "./reserve.ts";
import { memoryLedgerStore } from "./store.ts";

const NOW = "2026-10-13T09:00:00.000Z";
const RESERVED = 0.9595; // scenePlanFixture: the estimate and the redo allowance
const TOL: BudgetTolerance = { percent: 10, cents: 25 };

function input(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return { requestId: ID.request, workspaceId: "ws_fixture", mode: "cap", plan: scenePlanFixture, requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100, now: NOW, tolerance: TOL, ...overrides };
}

function call(overrides: Partial<CallInput> = {}): CallInput {
  return { reservationId: ID.reservation, stage: "produce_shot", provider: "openrouter", model: "seedance-2.0-mini", estimateUsd: 0.2, idempotencyKey: "produce:shot_3:1", at: "2026-10-13T09:01:00.000Z", ...overrides };
}

test("one cent over the request budget is reserved in cap mode, and the alert still names the budget", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: RESERVED - 0.01 }));
  assert.equal(result.reservation.state, "reserved", "a hold inside the tolerance is not paused");
  assert.equal(result.reservation.requestAllowanceUsd, allowanceUsd(RESERVED - 0.01, TOL), "the allowance is stored with the reservation");
  assert.ok(result.alerts.some((alert) => alert.scope === "request"), "the overrun of the budget itself is still reported");
});

test("a hold past the request allowance is paused in cap mode, with the tolerance named in the reason", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "paused");
  assert.match(result.reservation.pausedReason ?? "", /past its allowance of 0\.75 USD \(the budget plus its tolerance\)/);
});

test("a call over its hold inside the request allowance is authorized, and the hold is raised", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  const authorized = await authorizeCall(store, call({ estimateUsd: 1.1 }));
  assert.equal(authorized.status, "authorized", "1.10 is past the budget of 1.00 but inside its allowance of 1.25");
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, 1.1);
});

test("a call past the request allowance is refused in cap mode, names the allowance, and records nothing", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  await authorizeCall(store, call({ estimateUsd: 1.1, idempotencyKey: "produce:shot_3:1" }));
  const refused = await authorizeCall(store, call({ estimateUsd: 0.2, idempotencyKey: "produce:shot_4:1" }));
  assert.equal(refused.status, "refused", "1.10 + 0.20 = 1.30 is past the allowance of 1.25");
  if (refused.status !== "refused") return;
  assert.match(refused.reason, /take the request to 1\.3 USD/);
  assert.equal((await store.listEntries(ID.reservation)).length, 1, "only the first call is recorded");
});

test("warn mode records an overrun past the budget and does not refuse, as before", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, mode: "warn", requestBudgetUsd: 1 }));
  const recorded = await authorizeCall(store, call({ estimateUsd: 1.5 }));
  assert.equal(recorded.status, "authorized");
});

test("the pre-flight hold keeps one cent over inside the tolerance, and pauses past it", async () => {
  const inside = await reserveFixed(memoryLedgerStore(), {
    requestId: ID.request,
    workspaceId: "ws_fixture",
    mode: "cap",
    requestBudgetUsd: 0.5,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    reservationId: ID.reservation,
    tolerance: TOL,
  });
  assert.equal(inside.reservation.state, "reserved", "0.52 held against a budget of 0.50 is inside the 0.25 tolerance");
  const past = await reserveFixed(memoryLedgerStore(), {
    requestId: ID.request,
    workspaceId: "ws_fixture",
    mode: "cap",
    requestBudgetUsd: 0.2,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    reservationId: ID.reservation,
    tolerance: TOL,
  });
  assert.equal(past.reservation.state, "paused", "0.52 held against 0.20 is past 0.45");
});

test("the extension keeps the allowances it was made with, and pauses past them", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, { requestId: ID.request, workspaceId: "ws_fixture", mode: "cap", requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100, now: NOW, reservationId: ID.reservation, tolerance: TOL });
  const extended = await extendReservation(store, { reservationId: ID.reservation, plan: scenePlanFixture, requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100, now: NOW, tolerance: TOL });
  assert.equal(extended.status, "extended");
  const paused = await extendReservation(store, { reservationId: ID.reservation, plan: scenePlanFixture, requestBudgetUsd: 0.5, workspaceMonthBudgetUsd: 100, now: NOW, tolerance: TOL });
  assert.equal(paused.status, "paused", "a plan of 0.96 is past the 0.75 allowance of a 0.50 budget");
});
