import assert from "node:assert/strict";
import test from "node:test";
import { budgetReservationSchema, EngineError, type BudgetMode, type ScenePlan } from "../contracts/index.ts";
import { FIXTURE_IDS as ID, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { UnknownPriceError } from "./estimate.ts";
import { authorizeCall, reserve, type CallInput, type ReserveInput } from "./reserve.ts";
import { memoryLedgerStore, type LedgerStore } from "./store.ts";

const NOW = "2026-10-13T09:00:00.000Z";
const RESERVED = 0.9595; // scenePlanFixture: estimate 0.8716 + redo allowance 0.0879
const SECOND_RESERVATION = "res_01J9ZK3M4N5P6Q7R8S9T0V1W2X";

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
    model: "fixture-model",
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

test("reserve writes no allowance fields: a budget is a line, not a tolerance (D12, contract v11)", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation }));
  assert.equal("requestAllowanceUsd" in result.reservation, false);
  assert.equal("workspaceMonthAllowanceUsd" in result.reservation, false);
  assert.equal(result.reservation.requestBudgetUsd, 4);
  assert.equal(result.reservation.workspaceMonthBudgetUsd, 100);
});

test("reserving again with the same reservation id returns the first reservation and stores nothing new", async () => {
  const store = memoryLedgerStore();
  const first = await reserve(store, input({ reservationId: ID.reservation }));
  const again = await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 0.01 }));
  assert.equal(again.created, false);
  assert.deepEqual(again.reservation, first.reservation);
  assert.equal(again.reservation.state, "reserved");
});

test("a plan above the request budget is held with a note, not paused: the budget is a line (D12)", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "reserved");
  assert.equal(result.reservation.pausedReason, undefined);
  assert.equal(result.reservation.reservedUsd, RESERVED, "the hold is the plan's estimate");
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.scope, "request");
  assert.match(result.alerts[0]?.message ?? "", /the request would commit 0.9595 USD, above its 0.5 USD budget/);
});

test("a plan whose estimate exceeds the workspace month budget is accepted with a note, and its first call is authorized", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "reserved", "the month has committed nothing, below its 0.50 budget, so the plan is accepted");
  const note = result.alerts.find((alert) => alert.scope === "workspace_month");
  assert.match(note?.message ?? "", /the workspace month would commit 0.9595 USD, above its 0.5 USD budget/);
  const first = await authorizeCall(store, call({ estimateUsd: 0.2016 }));
  assert.equal(first.status, "authorized", "nothing is committed yet, so the first call starts");
});

test("a reservation that starts once its month's committed spend has reached the month budget is accepted with a note, not paused; its first call is refused at the line (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 1 }));
  const first = await authorizeCall(store, call({ estimateUsd: 1, idempotencyKey: "produce:shot_1:1" }));
  assert.equal(first.status, "authorized");
  const next = await reserve(store, input({ reservationId: SECOND_RESERVATION, workspaceMonthBudgetUsd: 1 }));
  assert.equal(next.reservation.state, "reserved", "a reservation is never paused at a line: its calls are gated by the line");
  assert.equal(next.reservation.pausedReason, undefined);
  assert.ok(next.alerts.some((alert) => alert.scope === "workspace_month"), "the plan that sits above the month's line is noted");
  const refused = await authorizeCall(store, call({ reservationId: SECOND_RESERVATION, estimateUsd: 0.01, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(refused.status, "refused");
  if (refused.status !== "refused") return;
  assert.match(refused.reason, /the workspace month has committed 1 USD, at or above its 1 USD budget, so no paid call starts/);
  assert.equal((await store.getReservation(SECOND_RESERVATION))?.state, "reserved");
  assert.equal((await store.listEntries(SECOND_RESERVATION)).length, 0, "the refused call holds nothing");
});

test("both budgets exceeded give a note each, and the reservation is still reserved", async () => {
  const store = memoryLedgerStore();
  const result = await reserve(store, input({ requestBudgetUsd: 0.5, workspaceMonthBudgetUsd: 0.5 }));
  assert.equal(result.reservation.state, "reserved");
  assert.deepEqual(
    result.alerts.map((alert) => alert.scope),
    ["request", "workspace_month"],
  );
});

test("an unspent plan does not count against the workspace month: only committed spend does (D12)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: RESERVED }));
  assert.equal(await store.committedForMonth("ws_fixture", "2026-10"), 0);
  const next = await reserve(store, input({ reservationId: SECOND_RESERVATION, workspaceMonthBudgetUsd: RESERVED }));
  assert.equal(next.reservation.state, "reserved", "nothing is committed, so the second plan is accepted");
  assert.deepEqual(next.alerts, [], "the month would commit exactly its budget, which is not above it");
});

test("the committed spend of an earlier month does not count against this month's line", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ now: "2026-09-30T23:00:00.000Z", reservationId: ID.reservation }));
  const september = await authorizeCall(
    store,
    call({ estimateUsd: 1.5, at: "2026-09-30T23:30:00.000Z", idempotencyKey: "produce:shot_1:1" }),
  );
  assert.equal(september.status, "authorized", "September's budget is 100 USD");
  const october = await reserve(store, input({ now: "2026-10-01T01:00:00.000Z", workspaceMonthBudgetUsd: 1, reservationId: SECOND_RESERVATION }));
  assert.equal(october.reservation.state, "reserved", "October has committed nothing, so its plan is accepted");
  const shot = await authorizeCall(
    store,
    call({ reservationId: SECOND_RESERVATION, estimateUsd: 0.5, at: "2026-10-01T01:05:00.000Z", idempotencyKey: "produce:shot_2:1" }),
  );
  assert.equal(shot.status, "authorized", "September's 1.50 USD is not October's committed spend");
});

test("warn mode records an over-budget reservation as reserved and returns a note", async () => {
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

test("cap authorizes a call over its hold while below the line, raises the hold, and returns the overrun as an alert", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  const authorized = await authorizeCall(store, call({ estimateUsd: RESERVED + 0.01 }));
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") return;
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, RESERVED + 0.01);
  assert.equal((await store.listEntries(ID.reservation)).length, 1);
  assert.ok(authorized.alerts.some((alert) => alert.scope === "call"), "the overrun of the hold is recorded, not hidden");
});

test("a call whose hold would take the request past its budget is refused, though the request has committed less than its budget (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  assert.equal((await authorizeCall(store, call({ estimateUsd: 0.9, idempotencyKey: "produce:shot_1:1" }))).status, "authorized");
  const crossing = await authorizeCall(store, call({ estimateUsd: 0.9, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(crossing.status, "refused", "0.90 is committed, below the 1.00 line, but this call's hold would take the request to 1.80");
  if (crossing.status !== "refused") return;
  assert.match(crossing.reason, /call produce_shot would take the request to 1.8 USD, above its 1 USD budget, so it does not start/);
  assert.ok(crossing.alerts.some((alert) => alert.scope === "request"), "the overshoot the call would cause is returned as a note");
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, RESERVED, "the refused call raises no hold");
  assert.equal((await store.listEntries(ID.reservation)).length, 1, "only the first call is recorded");
});

test("a call is refused once the request's committed amount reaches its budget, and records nothing", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  await authorizeCall(store, call({ estimateUsd: 1, idempotencyKey: "produce:shot_1:1" }));
  const refused = await authorizeCall(store, call({ estimateUsd: 0.2, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(refused.status, "refused");
  if (refused.status !== "refused") return;
  assert.match(refused.reason, /the request has committed 1 USD, at or above its 1 USD budget, so no paid call starts/);
  assert.equal((await store.listEntries(ID.reservation)).length, 1, "only the first call is recorded");
});

test("a remake's reservation sees the request's committed spend across its reservations (D12, D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  assert.equal((await authorizeCall(store, call({ estimateUsd: 0.5, idempotencyKey: "produce:shot_1:1" }))).status, "authorized");
  // A remake opens a reservation of its own for the same request.
  await reserve(store, input({ reservationId: SECOND_RESERVATION, requestBudgetUsd: 1 }));
  const fills = await authorizeCall(store, call({ reservationId: SECOND_RESERVATION, estimateUsd: 0.5, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(fills.status, "authorized", "the request has committed 0.5 USD, and this call's 0.5 USD fills its 1 USD budget exactly");
  const atLine = await authorizeCall(store, call({ reservationId: SECOND_RESERVATION, estimateUsd: 0.2, idempotencyKey: "produce:shot_3:1" }));
  assert.equal(atLine.status, "refused", "the request has committed 1 USD across its reservations, though this one holds only 0.5 USD");
  if (atLine.status === "refused") assert.match(atLine.reason, /the request has committed 1 USD, at or above its 1 USD budget/);
  assert.equal((await store.listEntries(SECOND_RESERVATION)).length, 1);
});

test("the workspace month's committed spend is read against its budget at the boundary: a call starts below it and is refused at it", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 1 }));
  await reserve(store, input({ reservationId: SECOND_RESERVATION, workspaceMonthBudgetUsd: 1 }));
  assert.equal((await authorizeCall(store, call({ estimateUsd: 0.99, idempotencyKey: "produce:shot_1:1" }))).status, "authorized");
  // The month has committed 0.99 USD, below its 1 USD budget: the next call starts.
  assert.equal((await authorizeCall(store, call({ estimateUsd: 0.01, idempotencyKey: "produce:shot_2:1" }))).status, "authorized");
  // The month has committed 1.00 USD, at its budget: no call starts, in either reservation.
  const atLine = await authorizeCall(store, call({ reservationId: SECOND_RESERVATION, estimateUsd: 0.01, idempotencyKey: "produce:shot_3:1" }));
  assert.equal(atLine.status, "refused");
  if (atLine.status !== "refused") return;
  assert.match(atLine.reason, /the workspace month has committed 1 USD, at or above its 1 USD budget, so no paid call starts/);
  assert.equal((await store.listEntries(SECOND_RESERVATION)).length, 0);
});

test("a call that exactly fills the month budget starts, and the next call in that month is refused at the line (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 1 }));
  const first = await authorizeCall(store, call({ estimateUsd: 1, idempotencyKey: "produce:shot_1:1" }));
  assert.equal(first.status, "authorized", "the month has committed nothing, and this call's 1.00 USD fills its line exactly");
  const second = await authorizeCall(store, call({ estimateUsd: 0.01, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(second.status, "refused", "the month now has committed 1.00 USD, at its budget");
});

test("a call whose hold fits under both budgets starts, with no note (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1, workspaceMonthBudgetUsd: 1 }));
  const fits = await authorizeCall(store, call({ estimateUsd: 0.6 }));
  assert.equal(fits.status, "authorized");
  if (fits.status !== "authorized") return;
  assert.deepEqual(fits.alerts, [], "0.60 is below both lines, and the hold is inside the reservation");
  assert.equal((await store.listEntries(ID.reservation)).length, 1);
});

test("a call whose hold would take the request past its budget is refused, even when nothing is committed (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  const refused = await authorizeCall(store, call({ estimateUsd: 1.5 }));
  assert.equal(refused.status, "refused");
  if (refused.status !== "refused") return;
  assert.match(refused.reason, /call produce_shot would take the request to 1.5 USD, above its 1 USD budget, so it does not start/);
  assert.ok(refused.alerts.some((alert) => alert.scope === "request"), "the overshoot the call would cause is returned as a note");
  assert.equal((await store.listEntries(ID.reservation)).length, 0, "a refused call holds nothing");
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, RESERVED, "the hold is unchanged");
});

test("a call at the request line is refused even with a zero estimate (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, requestBudgetUsd: 1 }));
  assert.equal((await authorizeCall(store, call({ estimateUsd: 1 }))).status, "authorized", "1.00 fills the line exactly, so it starts");
  const atLine = await authorizeCall(store, call({ estimateUsd: 0, idempotencyKey: "produce:shot_2:1" }));
  assert.equal(atLine.status, "refused");
  if (atLine.status !== "refused") return;
  assert.match(atLine.reason, /the request has committed 1 USD, at or above its 1 USD budget, so no paid call starts/);
  assert.equal((await store.listEntries(ID.reservation)).length, 1, "only the first call is recorded");
});

test("the workspace month line: a hold that would take the month past it is refused, and a zero-estimate call at the line is refused (D17)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 1 }));
  const over = await authorizeCall(store, call({ estimateUsd: 1.5 }));
  assert.equal(over.status, "refused", "nothing is committed, but the hold would take the month to 1.50 USD");
  if (over.status !== "refused") return;
  assert.match(over.reason, /call produce_shot would take the workspace month to 1.5 USD, above its 1 USD budget, so it does not start/);
  assert.equal((await authorizeCall(store, call({ estimateUsd: 1, idempotencyKey: "produce:shot_2:1" }))).status, "authorized", "1.00 fills the month line exactly");
  const atLine = await authorizeCall(store, call({ estimateUsd: 0, idempotencyKey: "produce:shot_3:1" }));
  assert.equal(atLine.status, "refused");
  if (atLine.status !== "refused") return;
  assert.match(atLine.reason, /the workspace month has committed 1 USD, at or above its 1 USD budget, so no paid call starts/);
  assert.equal((await store.listEntries(ID.reservation)).length, 1, "only the call that fits is recorded");
});

test("a reservation that records no budget refuses an overrun of its hold in cap mode, and allows a call inside it (fail closed)", async () => {
  const store = memoryLedgerStore();
  const reserved = await reserve(store, input({ reservationId: ID.reservation }));
  const unbudgeted: Record<string, unknown> = { ...reserved.reservation };
  delete unbudgeted.requestBudgetUsd;
  delete unbudgeted.workspaceMonthBudgetUsd;
  await store.updateReservation(budgetReservationSchema.parse(unbudgeted));

  const inside = await authorizeCall(store, call({ estimateUsd: RESERVED }));
  assert.equal(inside.status, "authorized", "a call that stays inside the hold is authorized");
  const over = await authorizeCall(store, call({ estimateUsd: 0.1, idempotencyKey: "produce:shot_9:1" }));
  assert.equal(over.status, "refused");
  if (over.status !== "refused") return;
  assert.match(over.reason, /records no budget to measure the call against/);
  assert.equal((await store.listEntries(ID.reservation)).length, 1);
});

test("in warn mode a reservation with no budget authorizes its overrun with an alert", async () => {
  const store = memoryLedgerStore();
  const reserved = await reserve(store, input({ reservationId: ID.reservation, mode: "warn" }));
  const unbudgeted: Record<string, unknown> = { ...reserved.reservation };
  delete unbudgeted.requestBudgetUsd;
  delete unbudgeted.workspaceMonthBudgetUsd;
  await store.updateReservation(budgetReservationSchema.parse(unbudgeted));
  const result = await authorizeCall(store, call({ estimateUsd: 1 }));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.equal(result.alerts.length, 1);
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
  const reserved = await reserve(store, input({ reservationId: ID.reservation }));
  await store.updateReservation(budgetReservationSchema.parse({ ...reserved.reservation, state: "paused", pausedReason: "paused before v11" }));
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

test("a Claude call is recorded with its role and prompt version (LedgerEntry, contract v2)", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  const result = await authorizeCall(
    store,
    call({ stage: "plan", provider: "openrouter", model: "fixture-model", estimateUsd: 0.16, role: "planner", promptVersion: "planner@1", idempotencyKey: "planner:1" }),
  );
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.equal(result.entry.role, "planner");
  assert.equal(result.entry.promptVersion, "planner@1");
  const [stored] = await store.listEntries(ID.reservation);
  assert.equal(stored?.role, "planner");
  assert.equal(stored?.promptVersion, "planner@1");
});

test("a call that is not a Claude call carries no role fields", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  const result = await authorizeCall(store, call());
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.equal("role" in result.entry, false);
  assert.equal("promptVersion" in result.entry, false);
});

test("a role without its prompt version, or the reverse, is refused before anything is written", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  await assert.rejects(
    authorizeCall(store, call({ role: "planner", idempotencyKey: "planner:x" })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  await assert.rejects(
    authorizeCall(store, call({ promptVersion: "planner@1", idempotencyKey: "planner:y" })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal((await store.listEntries(ID.reservation)).length, 0);
});

test("a role that is not in the Bible 11.1 list is refused by the contract before it is written", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  await assert.rejects(
    authorizeCall(store, call({ role: "copywriter" as never, promptVersion: "copywriter@1", idempotencyKey: "copy:1" })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal((await store.listEntries(ID.reservation)).length, 0);
});

test("a duplicate key with a different role is flagged as not the same payload", async () => {
  const store = memoryLedgerStore();
  await reserve(store, input({ reservationId: ID.reservation }));
  await authorizeCall(store, call({ role: "planner", promptVersion: "planner@1", idempotencyKey: "claude:same" }));
  const other = await authorizeCall(store, call({ role: "critic_take", promptVersion: "critic_take@1", idempotencyKey: "claude:same" }));
  assert.equal(other.status, "duplicate");
  if (other.status !== "duplicate") return;
  assert.equal(other.samePayload, false);
  assert.equal(other.entry.role, "planner");
});
