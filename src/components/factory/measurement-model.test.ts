import assert from "node:assert/strict";
import test from "node:test";
import { metricLine, receiptLine, type MetricRowValues } from "./measurement-model.ts";

const EMPTY: MetricRowValues = {
  views: null,
  reach: null,
  impressions: null,
  clicks: null,
  shares: null,
  saves: null,
  conversions: null,
  spendCents: null,
  completionRate: null,
};

test("a paid ad that is paused reads as paused, not live, and a not-connected channel reads as not connected", () => {
  assert.equal(
    receiptLine({ surface: "paid", platform: "test", status: "paused", externalId: "test_ad_0123456789ab", reason: "" }),
    "Paid test: paused, not live · id test_ad_0123456789ab",
  );
  assert.equal(
    receiptLine({ surface: "organic", platform: "youtube", status: "not_connected", externalId: "", reason: "No YouTube channel is connected." }),
    "Organic youtube: not connected · No YouTube channel is connected.",
  );
});

test("an unknown receipt status is shown as stored, never guessed", () => {
  assert.equal(receiptLine({ surface: "organic", platform: "youtube", status: "queued", externalId: "", reason: "" }), "Organic youtube: queued");
});

test("an organic metric the source did not report reads not reported, and a reported zero reads as zero", () => {
  const line = metricLine("organic", { ...EMPTY, views: 0, shares: 4 });
  assert.match(line, /^0 views · 4 shares · saves not reported · completion not reported$/);
});

test("a paid metric that was not reported reads not reported, and spend is shown in dollars when it is reported", () => {
  const line = metricLine("paid", { ...EMPTY, impressions: 1200, clicks: 34, spendCents: 1250, conversions: null });
  assert.equal(line, "1200 impressions · 34 clicks · $12.50 spend · conversions not reported");
  assert.equal(metricLine("paid", EMPTY), "impressions not reported · clicks not reported · spend not reported · conversions not reported");
});
