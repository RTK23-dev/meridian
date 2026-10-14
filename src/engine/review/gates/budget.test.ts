import assert from "node:assert/strict";
import test from "node:test";
import { budgets } from "../../config/budgets.ts";
import { gateResultSchema, type BudgetReservation } from "../../contracts/index.ts";
import { budgetReservationFixture } from "../../contracts/fixtures/index.ts";
import { checkBudget } from "./budget.ts";

function reservation(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return { ...structuredClone(budgetReservationFixture), ...overrides };
}

function state(result: ReturnType<typeof checkBudget>, rule: string): boolean | undefined {
  return result.checks.find((item) => item.rule === rule)?.pass;
}

test("the fixture reservation passes: it succeeded, is not paused, is in cap mode and covers its estimate", () => {
  const result = checkBudget(budgetReservationFixture);
  assert.equal(result.gate, "budget");
  assert.equal(result.pass, true, JSON.stringify(result.checks));
  assert.equal(result.subjectId, budgetReservationFixture.reservationId);
  assert.equal(gateResultSchema.safeParse(result).success, true);
});

test("a paused reservation fails: reservation_succeeded and not_paused both fail, and the reason is named", () => {
  const paused = reservation({ state: "paused", pausedReason: "request budget 0.5 USD is below the reservation of 0.9595 USD" });
  const result = checkBudget(paused);
  assert.equal(result.pass, false);
  assert.equal(state(result, "reservation_succeeded"), false);
  assert.equal(state(result, "not_paused"), false);
  assert.match(result.checks.find((item) => item.rule === "not_paused")?.detail ?? "", /below the reservation/);
});

test("a released reservation is not a reservation that succeeded for a pre-production gate", () => {
  const result = checkBudget(reservation({ state: "released" }));
  assert.equal(state(result, "reservation_succeeded"), false);
});

test("an observe or warn reservation fails cap_mode, because production runs in cap mode", () => {
  assert.equal(budgets.productionMode, "cap");
  assert.equal(state(checkBudget(reservation({ mode: "observe" })), "cap_mode"), false);
  assert.equal(state(checkBudget(reservation({ mode: "warn" })), "cap_mode"), false);
});

test("a reservation that does not equal its estimate plus the redo allowance fails reserved_covers_estimate", () => {
  const result = checkBudget(reservation({ reservedUsd: 1 }));
  assert.equal(state(result, "reserved_covers_estimate"), false);
  assert.equal(result.checks.find((item) => item.rule === "reserved_covers_estimate")?.value, 1);
});

test("a reservation that does not parse fails the first check and names every other check as not evaluated", () => {
  const result = checkBudget({ schema: "meridian.budget_reservation/v1" });
  assert.equal(result.pass, false);
  assert.equal(state(result, "reservation_succeeded"), false);
  assert.match(result.checks.find((item) => item.rule === "cap_mode")?.detail ?? "", /not evaluated/);
  assert.equal(result.subjectId, "budget:unparsed");
});
