// The freshness labels (B13, Q24 a): a stored item is fresh up to 30 days, aging up to 90 and stale after; an unreadable time has no label.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assessEvidence, freshnessOf } from "./evidence.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

test("the age bands are fresh up to 30 days, aging up to 90, and stale after", () => {
  assert.equal(freshnessOf(NOW - 5 * DAY, NOW), "fresh");
  assert.equal(freshnessOf(NOW - 45 * DAY, NOW), "aging");
  assert.equal(freshnessOf(NOW - 120 * DAY, NOW), "stale");
});

test("an unreadable time has no label, and the label agrees with the evidence assessment", () => {
  assert.equal(freshnessOf(Number.NaN, NOW), null);
  assert.equal(freshnessOf(NOW, Number.NaN), null);
  const age = 45 * DAY;
  assert.equal(freshnessOf(NOW - age, NOW), assessEvidence({ text: "x".repeat(60), collectedAt: NOW - age, now: NOW, duplicate: false }).freshness);
});
