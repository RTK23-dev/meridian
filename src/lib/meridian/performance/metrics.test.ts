import assert from "node:assert/strict";
import test from "node:test";
import { deriveMetrics, metricOf, performanceTotalsOf } from "./metrics.ts";

test("a stored metric is its value, or null when nothing was stored", () => {
  assert.equal(metricOf(null), null);
  assert.equal(metricOf(undefined), null);
  assert.equal(metricOf(""), null);
  assert.equal(metricOf("abc"), null);
  assert.equal(metricOf(0), 0, "a measured zero stays zero");
  assert.equal(metricOf("0"), 0);
  assert.equal(metricOf("12"), 12);
  assert.equal(metricOf(7), 7);
});

test("the paid totals of a row keep an unreported metric as null, not zero", () => {
  const totals = performanceTotalsOf({
    impressions: null,
    reach: null,
    clicks: 12,
    conversions: null,
    spend_cents: 500,
    revenue_cents: null,
  });
  assert.deepEqual(totals, {
    impressions: null,
    reach: null,
    clicks: 12,
    conversions: null,
    spendCents: 500,
    revenueCents: null,
  });
});

test("rates built on an unreported metric stay null, and a measured zero still reads as zero", () => {
  const unknownImpressions = deriveMetrics({
    impressions: null, reach: null, clicks: 12, conversions: null, spendCents: 500, revenueCents: null,
  });
  assert.equal(unknownImpressions.ctr, null, "CTR needs impressions");
  assert.equal(unknownImpressions.cpmCents, null, "CPM needs impressions");
  assert.equal(unknownImpressions.cvr, null, "conversion rate needs conversions");
  assert.equal(unknownImpressions.roas, null, "ROAS needs revenue");
  assert.equal(unknownImpressions.cpcCents, 42, "cost per click needs only spend and clicks");

  const measuredZero = deriveMetrics({
    impressions: 100, reach: 80, clicks: 0, conversions: 0, spendCents: 0, revenueCents: 0,
  });
  assert.equal(measuredZero.ctr, 0, "a measured zero click count is a real CTR of 0");
  assert.equal(measuredZero.roas, null, "zero spend has no ROAS");
  assert.equal(measuredZero.cpaCents, null, "no conversions has no cost per acquisition");
});
