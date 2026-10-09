import assert from "node:assert/strict";
import test from "node:test";
import { validateCap, toMicros, toUsd, InvalidBudgetCapError } from "./budget-ledger.ts";

test("Budget cap validation: rejects NaN, Infinity, negative, and excessive numbers", () => {
  assert.throws(() => validateCap(NaN), InvalidBudgetCapError);
  assert.throws(() => validateCap(Infinity), InvalidBudgetCapError);
  assert.throws(() => validateCap(-1), InvalidBudgetCapError);
  assert.throws(() => validateCap(-0.01), InvalidBudgetCapError);
  assert.throws(() => validateCap(null as any), InvalidBudgetCapError);
  assert.throws(() => validateCap(undefined as any), InvalidBudgetCapError);
  assert.throws(() => validateCap(100_001), InvalidBudgetCapError); // Exceeds MAX_SAFE_CAP_USD
});

test("Budget cap validation: accurately converts USD to micro-units without floating point drift", () => {
  assert.equal(toMicros(10.0), 10_000_000n);
  assert.equal(validateCap(10.0), 10_000_000n);
  assert.equal(validateCap(0.01), 10_000n);
  assert.equal(validateCap(1.25), 1_250_000n);
  assert.equal(validateCap(0), 0n);

  assert.equal(toUsd(10_000_000n), 10.0);
  assert.equal(toUsd(1_250_000n), 1.25);
  assert.equal(toUsd(10_000n), 0.01);
});
