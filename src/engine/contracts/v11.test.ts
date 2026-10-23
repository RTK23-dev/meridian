// Contract v11 (Bible section 4, v11 note; D12, a budget is a line): the reservation's two allowance fields are retired. A reservation
// written from v11 carries neither, and a row stored before v11 may carry both. Both shapes must parse, and the allowances must stay USD.

import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACTS_VERSION, budgetReservationSchema, type BudgetReservation } from "./index.ts";
import { budgetReservationFixture } from "./fixtures/index.ts";

test("the contract set is engine-contracts@11 (the version the v11 note of Bible section 4 records)", () => {
  assert.equal(CONTRACTS_VERSION, "engine-contracts@11");
});

test("a reservation without the retired allowance fields parses, as reserve() writes it from v11", () => {
  const fromV11: BudgetReservation = { ...budgetReservationFixture, requestBudgetUsd: 4, workspaceMonthBudgetUsd: 100 };
  const parsed = budgetReservationSchema.parse(fromV11);
  assert.equal("requestAllowanceUsd" in parsed, false);
  assert.equal("workspaceMonthAllowanceUsd" in parsed, false);
  assert.equal(parsed.requestBudgetUsd, 4);
  assert.equal(parsed.workspaceMonthBudgetUsd, 100);
});

test("a reservation that still carries the retired fields parses, and keeps them, as a row stored before v11 does", () => {
  const storedBefore: BudgetReservation = {
    ...budgetReservationFixture,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    requestAllowanceUsd: 4.25,
    workspaceMonthAllowanceUsd: 101,
  };
  const parsed = budgetReservationSchema.parse(storedBefore);
  assert.equal(parsed.requestAllowanceUsd, 4.25);
  assert.equal(parsed.workspaceMonthAllowanceUsd, 101);
});

test("a reservation written before contract v6, with no budgets and no allowances, still parses", () => {
  assert.equal(budgetReservationSchema.safeParse(budgetReservationFixture).success, true);
});

test("a retired allowance is a USD amount: one with five decimals is refused", () => {
  assert.equal(budgetReservationSchema.safeParse({ ...budgetReservationFixture, requestAllowanceUsd: 4.00001 }).success, false);
});
