import assert from "node:assert/strict";
import test from "node:test";
import { budgetReservationSchema, EngineError, sumUsd, type ScenePlan } from "../contracts/index.ts";
import { FIXTURE_IDS as ID, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { budgets } from "../config/budgets.ts";
import { estimatePlan, fixedBudgetLines, UnknownPriceError } from "./estimate.ts";
import {
  extendReservation,
  reserveFixed,
  type ExtendReservationInput,
  type ReserveFixedInput,
} from "./preflight.ts";
import { reconcileCall, releaseReservation } from "./reconcile.ts";
import { authorizeCall } from "./reserve.ts";
import { memoryLedgerStore, type LedgerStore } from "./store.ts";

const NOW = "2026-10-13T09:00:00.000Z";
const WORKSPACE = "ws_fixture";
const SECOND_RESERVATION = "res_01J9ZK3M4N5P6Q7R8S9T0V1W2X";
const THIRD_RESERVATION = "res_01J9ZK3M4N5P6Q7R8S9T0V1W3Y";

/** The fixed per-master lines (14.2): $0.40 + $0.05 + $0.05 + $0.02. */
const FIXED = 0.52;
/** scenePlanFixture: estimate 0.8716 + redo allowance 0.0879. */
const PLAN_RESERVED = 0.9595;

function fixedInput(overrides: Partial<ReserveFixedInput> = {}): ReserveFixedInput {
  return {
    requestId: ID.request,
    workspaceId: WORKSPACE,
    mode: "cap",
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    reservationId: ID.reservation,
    ...overrides,
  };
}

function extendInput(overrides: Partial<ExtendReservationInput> = {}): ExtendReservationInput {
  return {
    reservationId: ID.reservation,
    plan: scenePlanFixture,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    ...overrides,
  };
}

/** The scene plan with every shot a coded component: no generation, so the plan is the fixed lines plus $0 shots. */
function componentsOnly(): ScenePlan {
  const plan = structuredClone(scenePlanFixture);
  plan.shots = plan.shots.map((shot) => ({
    ...shot,
    source: { kind: "component", component: "kinetic.punchline", props: {} },
    visualType: "kinetic_type",
    downgradeTo: undefined,
  }));
  return plan;
}

/** A store wrapper that counts reservation writes, so a test can prove that nothing was written. */
function countingWrites(store: LedgerStore): { store: LedgerStore; writes: () => number } {
  let writes = 0;
  return {
    store: {
      ...store,
      async updateReservation(reservation) {
        writes += 1;
        return store.updateReservation(reservation);
      },
    },
    writes: () => writes,
  };
}

// reserveFixed: the pre-flight hold at intake.

test("the pre-flight hold fits: it holds the fixed per-master lines only, at the config amount of $0.52", async () => {
  const store = memoryLedgerStore();
  const result = await reserveFixed(store, fixedInput());
  assert.equal(result.created, true);
  assert.equal(result.reservation.state, "reserved");
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.reservation.lines, fixedBudgetLines());
  assert.deepEqual(
    result.reservation.lines.map((line) => line.stage),
    ["claude_roles", "critic", "render", "media"],
  );
  assert.equal(result.reservation.estimateUsd, FIXED);
  assert.equal(result.reservation.reservedUsd, FIXED);
  assert.equal(result.reservation.redoAllowanceUsd, 0, "a pre-flight hold has no redo allowance");
  assert.equal(result.reservation.pausedReason, undefined);
  assert.equal(sumUsd(Object.values(budgets.fixedPerMasterUsd)), FIXED, "the hold reads its amount from config");
  budgetReservationSchema.parse(result.reservation);
});

test("a pre-flight hold over the request budget pauses in cap mode, names the reason, and holds nothing", async () => {
  const store = memoryLedgerStore();
  const result = await reserveFixed(store, fixedInput({ requestBudgetUsd: 0.4 }));
  assert.equal(result.reservation.state, "paused");
  assert.match(result.reservation.pausedReason ?? "", /request budget 0.4 USD is below the reservation of 0.52 USD/);
  assert.equal(result.reservation.reservedUsd, FIXED, "a paused hold says what it would hold");
  assert.equal(result.alerts[0]?.scope, "request");
  assert.deepEqual(await store.sumForMonth(WORKSPACE, "2026-10"), { reservedUsd: 0, actualUsd: 0 });
});

test("a pre-flight hold over the request budget is held with an alert in warn mode", async () => {
  const store = memoryLedgerStore();
  const result = await reserveFixed(store, fixedInput({ mode: "warn", requestBudgetUsd: 0.4 }));
  assert.equal(result.reservation.state, "reserved");
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.scope, "request");
  assert.equal((await store.sumForMonth(WORKSPACE, "2026-10")).reservedUsd, FIXED);
});

test("a pre-flight hold over the request budget is recorded silently in observe mode", async () => {
  const store = memoryLedgerStore();
  const result = await reserveFixed(store, fixedInput({ mode: "observe", requestBudgetUsd: 0.4 }));
  assert.equal(result.reservation.state, "reserved");
  assert.deepEqual(result.alerts, []);
});

test("a pre-flight hold that takes the workspace month over its budget pauses in cap mode, with the monthly reason", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 0.8 }));
  const second = await reserveFixed(store, fixedInput({ reservationId: SECOND_RESERVATION, workspaceMonthBudgetUsd: 0.8 }));
  assert.equal(second.reservation.state, "paused");
  assert.match(second.reservation.pausedReason ?? "", /workspace monthly budget 0.8 USD would be exceeded: 1.04 USD committed/);
  assert.equal(second.alerts[0]?.scope, "workspace_month");
});

test("a month that fits exactly at its budget is not over it", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ reservationId: ID.reservation, workspaceMonthBudgetUsd: 1.04 }));
  const second = await reserveFixed(store, fixedInput({ reservationId: SECOND_RESERVATION, workspaceMonthBudgetUsd: 1.04 }));
  assert.equal(second.reservation.state, "reserved");
});

test("holds from an earlier month do not count against this month", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ now: "2026-09-30T23:00:00.000Z" }));
  const october = await reserveFixed(store, fixedInput({
    reservationId: SECOND_RESERVATION,
    now: "2026-10-01T01:00:00.000Z",
    workspaceMonthBudgetUsd: FIXED,
  }));
  assert.equal(october.reservation.state, "reserved");
});

test("both budgets exceeded give both reasons", async () => {
  const store = memoryLedgerStore();
  const result = await reserveFixed(store, fixedInput({ requestBudgetUsd: 0.4, workspaceMonthBudgetUsd: 0.4 }));
  assert.equal(result.reservation.state, "paused");
  assert.match(result.reservation.pausedReason ?? "", /request budget.*; workspace monthly budget/);
  assert.equal(result.alerts.length, 2);
});

test("reserving again with the same reservation id returns the first hold and stores nothing new", async () => {
  const store = memoryLedgerStore();
  const first = await reserveFixed(store, fixedInput());
  const again = await reserveFixed(store, fixedInput({ requestBudgetUsd: 0.1, workspaceMonthBudgetUsd: 0.1 }));
  assert.equal(again.created, false);
  assert.deepEqual(again.reservation, first.reservation);
  assert.equal(again.reservation.state, "reserved", "the first answer stands, even with tighter budgets now");
  assert.equal((await store.sumForMonth(WORKSPACE, "2026-10")).reservedUsd, FIXED, "only one hold is stored");
});

test("without a reservation id a new res_ id is made", async () => {
  const store = memoryLedgerStore();
  const result = await reserveFixed(store, fixedInput({ reservationId: undefined }));
  assert.match(result.reservation.reservationId, /^res_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual(await store.getReservation(result.reservation.reservationId), result.reservation);
});

test("invalid inputs are refused as invalid_input before anything is stored", async () => {
  const store = memoryLedgerStore();
  const bad: [string, Partial<ReserveFixedInput>][] = [
    ["a requestId that is not req_", { requestId: "led_01J9ZK3M4N5P6Q7R8S9T0V1W2X" }],
    ["an empty workspace", { workspaceId: "" }],
    ["a negative request budget", { requestBudgetUsd: -1 }],
    ["a month budget with five decimals", { workspaceMonthBudgetUsd: 1.00001 }],
    ["a time that is not ISO", { now: "13/10/2026" }],
    ["a mode that does not exist", { mode: "turbo" as "cap" }],
    ["a reservation id with another prefix", { reservationId: ID.ledgerRender }],
  ];
  for (const [name, overrides] of bad) {
    await assert.rejects(reserveFixed(store, fixedInput(overrides)), (error: unknown) => {
      assert.ok(error instanceof EngineError, `${name}: expected an EngineError`);
      assert.equal(error.kind, "invalid_input", name);
      return true;
    });
  }
  assert.deepEqual(await store.getReservation(ID.reservation), null);
});

// extendReservation: the plan raises the pre-flight hold to its estimate.

test("extending a pre-flight hold replaces the fixed lines with the plan's lines and holds the plan's estimate plus redo", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const result = await extendReservation(store, extendInput());
  assert.equal(result.status, "extended");
  if (result.status !== "extended") return;
  assert.equal(result.changed, true);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.reservation.state, "reserved");
  assert.deepEqual(result.reservation.lines, estimatePlan(scenePlanFixture).lines);
  assert.equal(result.reservation.estimateUsd, scenePlanFixture.estimatedUsd + FIXED);
  assert.equal(result.reservation.redoAllowanceUsd, 0.0879);
  assert.equal(result.reservation.reservedUsd, PLAN_RESERVED);
  assert.deepEqual(await store.getReservation(ID.reservation), result.reservation);
  budgetReservationSchema.parse(result.reservation);
});

test("the fixed lines stay inside the extended reservation, line for line", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const result = await extendReservation(store, extendInput());
  assert.equal(result.status, "extended");
  if (result.status !== "extended") return;
  for (const fixed of fixedBudgetLines()) {
    assert.ok(
      result.reservation.lines.some((line) => line.stage === fixed.stage && line.estimateUsd === fixed.estimateUsd),
      `fixed line ${fixed.stage} is missing from the extended reservation`,
    );
  }
});

test("an all-code plan extends the hold to the fixed amount, with no redo allowance", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const result = await extendReservation(store, extendInput({ plan: componentsOnly() }));
  assert.equal(result.status, "extended");
  if (result.status !== "extended") return;
  assert.equal(result.reservation.reservedUsd, FIXED);
  assert.equal(result.reservation.redoAllowanceUsd, 0);
});

test("a request over budget pauses the extension in cap mode: nothing is written and the hold stays as it was", async () => {
  const store = memoryLedgerStore();
  const before = await reserveFixed(store, fixedInput());
  const counted = countingWrites(store);
  const result = await extendReservation(counted.store, extendInput({ requestBudgetUsd: 0.9 }));
  assert.equal(result.status, "paused");
  if (result.status !== "paused") return;
  assert.match(result.reasons[0] ?? "", /request budget 0.9 USD is below the reservation of 0.9595 USD/);
  assert.equal(result.reservation.reservedUsd, FIXED);
  assert.equal(counted.writes(), 0);
  assert.deepEqual(await store.getReservation(ID.reservation), before.reservation);
});

test("a request over budget is extended with an alert in warn mode", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ mode: "warn" }));
  const result = await extendReservation(store, extendInput({ requestBudgetUsd: 0.9 }));
  assert.equal(result.status, "extended");
  if (result.status !== "extended") return;
  assert.equal(result.alerts[0]?.scope, "request");
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, PLAN_RESERVED);
});

test("a workspace month over budget pauses the extension in cap mode, with the monthly reason", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const result = await extendReservation(store, extendInput({ workspaceMonthBudgetUsd: 0.9 }));
  assert.equal(result.status, "paused");
  if (result.status !== "paused") return;
  assert.match(result.reasons.join("; "), /workspace monthly budget 0.9 USD would be exceeded: 0.9595 USD committed/);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, FIXED);
});

test("the month check counts the other holds of the month, and fits exactly at its budget", async () => {
  // Another hold of $0.52 in the same month. This hold grows from $0.52 to $0.9595: the month is 0.52 + 0.9595 = 1.4795.
  const fits = memoryLedgerStore();
  await reserveFixed(fits, fixedInput());
  await reserveFixed(fits, fixedInput({ reservationId: SECOND_RESERVATION }));
  const exact = await extendReservation(fits, extendInput({ workspaceMonthBudgetUsd: 1.4795 }));
  assert.equal(exact.status, "extended");

  const over = memoryLedgerStore();
  await reserveFixed(over, fixedInput());
  await reserveFixed(over, fixedInput({ reservationId: SECOND_RESERVATION }));
  const paused = await extendReservation(over, extendInput({ workspaceMonthBudgetUsd: 1.4794 }));
  assert.equal(paused.status, "paused");
  if (paused.status !== "paused") return;
  assert.match(paused.reasons.join("; "), /workspace monthly budget 1.4794 USD/);
  assert.equal((await over.getReservation(ID.reservation))?.reservedUsd, FIXED, "the other hold is not counted twice");
});

test("a month over budget is extended with an alert in warn mode and recorded silently in observe mode", async () => {
  const warn = memoryLedgerStore();
  await reserveFixed(warn, fixedInput({ mode: "warn" }));
  const warned = await extendReservation(warn, extendInput({ workspaceMonthBudgetUsd: 0.9 }));
  assert.equal(warned.status, "extended");
  if (warned.status === "extended") assert.equal(warned.alerts[0]?.scope, "workspace_month");

  const observe = memoryLedgerStore();
  await reserveFixed(observe, fixedInput({ mode: "observe" }));
  const observed = await extendReservation(observe, extendInput({ workspaceMonthBudgetUsd: 0.9 }));
  assert.equal(observed.status, "extended");
  if (observed.status === "extended") assert.deepEqual(observed.alerts, []);
});

test("extending again with the same plan writes nothing and reports no change", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const counted = countingWrites(store);
  const first = await extendReservation(counted.store, extendInput());
  const again = await extendReservation(counted.store, extendInput());
  assert.equal(first.status === "extended" && first.changed, true);
  assert.equal(again.status === "extended" && again.changed, false);
  assert.equal(counted.writes(), 1, "only the first extension is written");
});

test("an extension below what is already committed is refused, and the hold is not lowered", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ mode: "warn" }));
  // A $0.60 call on a $0.52 hold: in warn mode it is authorized and raises the hold to $0.60.
  const call = await authorizeCall(store, {
    reservationId: ID.reservation,
    stage: "voice",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5.5",
    estimateUsd: 0.6,
    idempotencyKey: "voice:req_fixture:1",
    at: NOW,
  });
  assert.equal(call.status, "authorized");
  const before = await store.getReservation(ID.reservation);
  const result = await extendReservation(store, extendInput({ plan: componentsOnly() }));
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.match(result.reason, /the plan estimate of 0.52 USD is below the 0.6 USD already committed/);
  assert.deepEqual(await store.getReservation(ID.reservation), before);
});

test("a plan that equals what is already committed is accepted", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const call = await authorizeCall(store, {
    reservationId: ID.reservation,
    stage: "voice",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5.5",
    estimateUsd: FIXED,
    idempotencyKey: "voice:req_fixture:1",
    at: NOW,
  });
  assert.equal(call.status, "authorized");
  const result = await extendReservation(store, extendInput({ plan: componentsOnly() }));
  assert.equal(result.status, "extended");
  if (result.status !== "extended") return;
  assert.equal(result.reservation.reservedUsd, FIXED);
});

test("the hold is never lowered below what it already holds, even when the plan is smaller", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ mode: "warn" }));
  await authorizeCall(store, {
    reservationId: ID.reservation,
    stage: "analyze_reference",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5.5",
    estimateUsd: 0.6,
    idempotencyKey: "analyze:req_fixture:1",
    at: NOW,
  });
  // The call came in at $0.10, so committed is $0.10 and the hold stays at $0.60 (reconcile does not lower it).
  await reconcileCall(store, { idempotencyKey: "analyze:req_fixture:1", actualUsd: 0.1 });
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, 0.6);

  const result = await extendReservation(store, extendInput({ plan: componentsOnly() }));
  assert.equal(result.status, "extended");
  if (result.status !== "extended") return;
  assert.equal(result.reservation.reservedUsd, 0.6, "the plan's $0.52 does not lower the $0.60 hold");
  assert.deepEqual(result.reservation.lines, estimatePlan(componentsOnly()).lines, "the lines are the plan's");
});

test("a paused pre-flight hold is refused: it holds nothing and the plan does not revive it", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ requestBudgetUsd: 0.4 }));
  const before = await store.getReservation(ID.reservation);
  const result = await extendReservation(store, extendInput());
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.match(result.reason, /is paused/);
  assert.deepEqual(await store.getReservation(ID.reservation), before);
});

test("a released reservation is refused", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  await releaseReservation(store, ID.reservation);
  const result = await extendReservation(store, extendInput());
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.match(result.reason, /is released/);
});

test("a reservation made in another month is refused, because its hold is counted in the month it was made", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput({ now: "2026-09-30T23:00:00.000Z" }));
  const result = await extendReservation(store, extendInput({ now: "2026-10-01T01:00:00.000Z" }));
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.match(result.reason, /was made in 2026-09 and cannot be extended in 2026-10/);
  assert.equal((await store.getReservation(ID.reservation))?.reservedUsd, FIXED);
});

test("an unknown price throws before anything is read or stored", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const before = await store.getReservation(ID.reservation);
  const plan = structuredClone(scenePlanFixture);
  plan.shots[0] = { ...plan.shots[0], source: { kind: "generate", modelClass: "image.edit", prompt: "x", refs: [], takes: 1 } };
  await assert.rejects(extendReservation(store, extendInput({ plan })), UnknownPriceError);
  assert.deepEqual(await store.getReservation(ID.reservation), before);
});

test("an invalid plan is refused as invalid_input before anything is stored", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const before = await store.getReservation(ID.reservation);
  await assert.rejects(extendReservation(store, extendInput({ plan: {} as ScenePlan })), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.kind, "invalid_input");
    return true;
  });
  assert.deepEqual(await store.getReservation(ID.reservation), before);
});

test("extending a reservation that does not exist is not_found", async () => {
  const store = memoryLedgerStore();
  await assert.rejects(extendReservation(store, extendInput({ reservationId: THIRD_RESERVATION })), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.kind, "not_found");
    return true;
  });
});

test("invalid extension inputs (a bad id, a bad budget, a bad time) are invalid_input", async () => {
  const store = memoryLedgerStore();
  await reserveFixed(store, fixedInput());
  const bad: [string, Partial<ExtendReservationInput>][] = [
    ["a reservation id with another prefix", { reservationId: ID.ledgerRender }],
    ["a negative request budget", { requestBudgetUsd: -4 }],
    ["a month budget that is NaN", { workspaceMonthBudgetUsd: Number.NaN }],
    ["a time that is not ISO", { now: "yesterday" }],
  ];
  for (const [name, overrides] of bad) {
    await assert.rejects(extendReservation(store, extendInput(overrides)), (error: unknown) => {
      assert.ok(error instanceof EngineError, `${name}: expected an EngineError`);
      assert.equal(error.kind, "invalid_input", name);
      return true;
    });
  }
});

test("the whole flow: pre-flight hold, a paid call, the plan's extension, the shot calls, reconcile and release", async () => {
  const store = memoryLedgerStore();
  const held = await reserveFixed(store, fixedInput());
  assert.equal(held.reservation.reservedUsd, FIXED);

  const analysis = await authorizeCall(store, {
    reservationId: ID.reservation,
    stage: "analyze_reference",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5.5",
    estimateUsd: 0.1,
    idempotencyKey: "analyze:req_fixture:1",
    at: NOW,
  });
  assert.equal(analysis.status, "authorized");

  const extended = await extendReservation(store, extendInput());
  assert.equal(extended.status, "extended");
  if (extended.status !== "extended") return;
  assert.equal(extended.reservation.reservedUsd, PLAN_RESERVED);

  const shot = await authorizeCall(store, {
    reservationId: ID.reservation,
    stage: "produce_shot",
    provider: "openrouter",
    model: "seedance-2.0-mini",
    estimateUsd: 0.2016,
    idempotencyKey: `produce:${ID.shot3}:1`,
    at: NOW,
  });
  assert.equal(shot.status, "authorized");

  await reconcileCall(store, { idempotencyKey: "analyze:req_fixture:1", actualUsd: 0.08 });
  await reconcileCall(store, { idempotencyKey: `produce:${ID.shot3}:1`, actualUsd: 0.2 });
  const released = await releaseReservation(store, ID.reservation);
  assert.equal(released.reservation.reservedUsd, 0.28, "the hold shrinks to what was committed");
  assert.equal(released.releasedUsd, 0.6795);
  assert.deepEqual(await store.sumForMonth(WORKSPACE, "2026-10"), { reservedUsd: 0.28, actualUsd: 0.28 });
});

test("the plan total used by extension is the estimate function's total, so the two cannot disagree", () => {
  const estimate = estimatePlan(scenePlanFixture);
  assert.equal(estimate.reservedUsd, PLAN_RESERVED);
  assert.equal(estimate.estimateUsd, sumUsd(estimate.lines.map((line) => line.estimateUsd)));
});
