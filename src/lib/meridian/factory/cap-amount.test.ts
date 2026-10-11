import assert from "node:assert/strict";
import test from "node:test";
import { isCapAmount } from "./cap-amount.ts";

test("a typed spend cap is zero or more: a negative fraction that rounds to zero is refused", () => {
  assert.equal(isCapAmount("-0.001"), false, "-0.001 rounds to -0 and must not pass");
  assert.equal(isCapAmount("-0.1"), false);
  assert.equal(isCapAmount("-1"), false);
  assert.equal(isCapAmount("0"), true);
  assert.equal(isCapAmount("0.001"), true);
  assert.equal(isCapAmount("12.5"), true);
});

test("a blank cap is not sent, so it is accepted, and text or infinity is refused", () => {
  assert.equal(isCapAmount(""), true);
  assert.equal(isCapAmount("   "), true);
  assert.equal(isCapAmount("abc"), false);
  assert.equal(isCapAmount("Infinity"), false);
  assert.equal(isCapAmount("NaN"), false);
});
