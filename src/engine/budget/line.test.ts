import { test } from "node:test";
import assert from "node:assert/strict";
import { positionOfLine, roundUpUsd, startsBelowLine } from "./line.ts";

test("roundUpUsd rounds up to four decimals and leaves an exact value alone", () => {
  assert.equal(roundUpUsd(0.12341), 0.1235);
  assert.equal(roundUpUsd(0.1234), 0.1234);
  assert.equal(roundUpUsd(1.5), 1.5);
  assert.ok(roundUpUsd(0) === 0);
});

test("a paid step starts only while the committed spend is below the line", () => {
  assert.equal(startsBelowLine(0, 0.5), true);
  assert.equal(startsBelowLine(0.49, 0.5), true);
  assert.equal(startsBelowLine(0.5, 0.5), false, "a spend at the line has reached it");
  assert.equal(startsBelowLine(0.75, 0.5), false, "a spend past the line starts nothing");
});

test("a float error in a sum does not decide whether a step starts", () => {
  const sum = 0.1 + 0.2;
  assert.equal(startsBelowLine(sum, 0.3), false, "the sum is at the line, not below it");
});

test("a total is within the budget at the line and over it past the line", () => {
  assert.equal(positionOfLine(0.5, 0.5), "within_budget");
  assert.equal(positionOfLine(0.5000001, 0.5), "over_budget");
  assert.equal(positionOfLine(0, 0), "within_budget");
});
