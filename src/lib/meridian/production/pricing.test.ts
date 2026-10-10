import assert from "node:assert/strict";
import test from "node:test";
import { configuredQuote, estimateCost, unknownQuote, type PriceQuote } from "./pricing.ts";

const verified = (amountUsd: number | null, verifiedAt: string | null): PriceQuote => ({
  status: "verified", unit: "per_second", amountUsd, source: "test price page", verifiedAt,
});

test("a configured per-second price estimates duration times the amount, and records its status", () => {
  const cost = estimateCost(configuredQuote("per_second", 0.05, "test"), 8, "per_second");
  assert.deepEqual(cost, { costKnown: true, costStatus: "configured", estimateUsd: 0.4 });
});

test("a verified price with a date estimates as known and keeps the verified status", () => {
  const cost = estimateCost(verified(0.15, "2026-10-01"), 8, "per_second");
  assert.deepEqual(cost, { costKnown: true, costStatus: "verified", estimateUsd: 1.2 });
});

test("a verified price with no date is not current, so it is not estimated", () => {
  const cost = estimateCost(verified(0.15, null), 8, "per_second");
  assert.deepEqual(cost, { costKnown: false, costStatus: "unknown", estimateUsd: null });
});

test("a declared zero price is a real price, so its estimate is zero and known", () => {
  const cost = estimateCost(configuredQuote("per_second", 0, "manual workflow"), 8, "per_second");
  assert.deepEqual(cost, { costKnown: true, costStatus: "configured", estimateUsd: 0 });
});

test("an unknown price gives no estimate, and is never recorded as zero", () => {
  const cost = estimateCost(unknownQuote("per_image", "none"), 1, "per_image");
  assert.deepEqual(cost, { costKnown: false, costStatus: "unknown", estimateUsd: null });
});

test("a configured price with no amount is unknown, not zero", () => {
  const cost = estimateCost({ status: "configured", unit: "per_image", amountUsd: null, source: "broken", verifiedAt: null }, 1, "per_image");
  assert.deepEqual(cost, { costKnown: false, costStatus: "unknown", estimateUsd: null });
});

test("a stale price keeps its status and is never estimated from", () => {
  const cost = estimateCost({ status: "stale", unit: "per_second", amountUsd: 0.05, source: "old page", verifiedAt: null }, 8, "per_second");
  assert.deepEqual(cost, { costKnown: false, costStatus: "stale", estimateUsd: null });
});

test("a price in another unit is not applied to a deliverable it does not price", () => {
  const cost = estimateCost(configuredQuote("per_second", 0.05, "test"), 1, "per_image");
  assert.deepEqual(cost, { costKnown: false, costStatus: "unknown", estimateUsd: null });
});

test("an estimate is rounded to micro-dollars, so it does not carry float noise", () => {
  const cost = estimateCost(configuredQuote("per_second", 0.1, "test"), 3, "per_second");
  assert.equal(cost.estimateUsd, 0.3);
});

test("a non-finite amount is not a price, so it cannot produce an estimate", () => {
  for (const amountUsd of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const cost = estimateCost(configuredQuote("per_second", amountUsd, "broken"), 8, "per_second");
    assert.deepEqual(cost, { costKnown: false, costStatus: "unknown", estimateUsd: null });
  }
});
