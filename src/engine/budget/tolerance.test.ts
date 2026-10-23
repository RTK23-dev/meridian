import { test } from "node:test";
import assert from "node:assert/strict";
import { allowanceUsd, budgetPosition, INITIAL_BUDGET_TOLERANCE, mayStart, roundUpUsd, toleranceUsd, type BudgetTolerance } from "./tolerance.ts";

const TOL: BudgetTolerance = { percent: 10, cents: 25 };

test("the initial tolerance is 10 percent of the target or 25 cents, whichever is larger", () => {
  assert.deepEqual(INITIAL_BUDGET_TOLERANCE, { percent: 10, cents: 25 });
  assert.equal(toleranceUsd(2, TOL), 0.25, "10 percent of 2 is 0.20, so the 25-cent floor applies");
  assert.equal(toleranceUsd(10, TOL), 1, "10 percent of 10 is 1.00, above the floor");
  assert.equal(toleranceUsd(0.5, TOL), 0.25, "a small target still gets the floor");
});

test("the allowance is the target plus its tolerance, and never less than the target", () => {
  assert.equal(allowanceUsd(2, TOL), 2.25);
  assert.equal(allowanceUsd(10, TOL), 11);
  assert.equal(allowanceUsd(2, { percent: 0, cents: 0 }), 2, "no tolerance is the strict budget");
});

test("one cent over the target is within the tolerance, never a stop", () => {
  assert.equal(budgetPosition(2.01, 2, TOL), "within_tolerance");
  assert.equal(budgetPosition(2, 2, TOL), "within_target");
  assert.equal(budgetPosition(2.25, 2, TOL), "within_tolerance", "the allowance itself is still within");
  assert.equal(budgetPosition(2.2501, 2, TOL), "needs_approval", "a hundredth of a cent past the allowance needs approval");
});

test("a strict tolerance keeps the old boundary: one cent over is past the budget", () => {
  assert.equal(budgetPosition(2.01, 2, { percent: 0, cents: 0 }), "needs_approval");
});

test("mayStart allows a further amount while the total stays within the allowance", () => {
  assert.equal(mayStart(1.9, 0.34, 2, TOL), true, "1.90 + 0.34 = 2.24, within 2.25");
  assert.equal(mayStart(1.9, 0.36, 2, TOL), false, "1.90 + 0.36 = 2.26, past 2.25");
  assert.equal(mayStart(0, 0, 2, TOL), true);
});

test("rounding is up to a hundredth of a cent, with no false step from floating error", () => {
  assert.equal(roundUpUsd(0.1 + 0.2), 0.3, "0.30000000000000004 rounds to 0.3, not 0.3001");
  assert.equal(roundUpUsd(0.00001), 0.0001, "a sub-tenth-of-a-cent amount is held at the next hundredth of a cent");
  assert.equal(roundUpUsd(1.00001), 1.0001);
});
