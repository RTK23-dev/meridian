import assert from "node:assert/strict";
import test from "node:test";
import { sparklineSummary } from "./sparkline-summary.ts";

test("a sparkline with no points says so, and never invents a trend", () => {
  assert.equal(sparklineSummary("Spend", []), "Spend trend: no points stored.");
});

test("one point is named as one point, with its value as first, last, lowest and highest", () => {
  assert.equal(sparklineSummary("Spend", [5]), "Spend trend over 1 point: first 5, last 5, lowest 5, highest 5.");
});

test("several points give the count, the first and last value, and the range", () => {
  assert.equal(sparklineSummary("Reach", [4, 1, 9.5, 3]), "Reach trend over 4 points: first 4, last 3, lowest 1, highest 9.5.");
});

test("large values use thousands separators and at most two decimals", () => {
  assert.equal(sparklineSummary("Views", [1200, 3456.789]), "Views trend over 2 points: first 1,200, last 3,456.79, lowest 1,200, highest 3,456.79.");
});

test("values that are not finite numbers are not counted as points", () => {
  assert.equal(sparklineSummary("CPC", [Number.NaN, 2, Number.POSITIVE_INFINITY, 4]), "CPC trend over 2 points: first 2, last 4, lowest 2, highest 4.");
  assert.equal(sparklineSummary("CPC", [Number.NaN, Number.NaN]), "CPC trend: no points stored.", "no finite point means no trend");
});
