import assert from "node:assert/strict";
import test from "node:test";
import { organicMetricsLine } from "./organic-metrics.ts";

test("a metric the platform did not report reads as not reported, never as zero", () => {
  const unknown = { views: null, threeSecondViews: null, completionRate: null, shares: null };
  assert.equal(
    organicMetricsLine(unknown),
    "views not reported · 3s hook not reported · completion not reported · shares not reported",
  );
  assert.equal(organicMetricsLine({ ...unknown, views: 0 }).startsWith("0 views · "), true, "a reported zero stays zero");
  assert.equal(organicMetricsLine({ ...unknown, views: 0 }).includes("NaN"), false);
});

test("reported metrics read as their values, and completion is shown as a percentage", () => {
  assert.equal(
    organicMetricsLine({ views: 1200, threeSecondViews: 340, completionRate: 0.425, shares: 9 }),
    "1200 views · 340 3s hook · 42.5% completion · 9 shares",
  );
});
