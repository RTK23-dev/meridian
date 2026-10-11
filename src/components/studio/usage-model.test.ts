import assert from "node:assert/strict";
import test from "node:test";
import { meterSummary } from "./usage-model.ts";

test("a reported count gives a bar and a summary against the limit", () => {
  assert.deepEqual(meterSummary(10, 40, "runs"), { known: true, percent: 25, summary: "10 of 40 runs", atLimit: false });
});

test("a count at or over the limit is flagged, and the bar stops at 100", () => {
  const over = meterSummary(45, 40, "runs");
  assert.equal(over.known && over.atLimit, true);
  assert.equal(over.known && over.percent, 100);
});

test("a missing count is unknown, names the limit, and has no bar", () => {
  const missing = meterSummary(null, 40, "runs");
  assert.equal(missing.known, false);
  assert.match(missing.known ? "" : missing.line, /Usage unknown\. The limit is 40 runs\./);
});

test("a count that is not a finite non-negative number is treated as unknown, never as zero", () => {
  assert.equal(meterSummary(Number.NaN, 3, "runs").known, false);
  assert.equal(meterSummary(-1, 3, "runs").known, false);
});
