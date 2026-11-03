import assert from "node:assert/strict";
import test from "node:test";
import { manualPerformanceSchema } from "./performance.ts";

test("manual performance accepts whole-number metrics and leaves a blank reach unknown", () => {
  const result = manualPerformanceSchema.parse({ observedOn: "2026-04-05", platform: "Meta", impressions: "100", clicks: "8", conversions: "2", spendCents: "500", revenueCents: "1000" });
  assert.equal(result.impressions, 100);
  assert.equal(result.reach, null);
});

test("a typed reach is kept, including a measured zero, and a bad reach is refused", () => {
  const base = { observedOn: "2026-04-05", platform: "", impressions: "10", clicks: "1", conversions: "0", spendCents: "0", revenueCents: "0" };
  assert.equal(manualPerformanceSchema.parse({ ...base, reach: "250" }).reach, 250);
  assert.equal(manualPerformanceSchema.parse({ ...base, reach: "0" }).reach, 0);
  assert.equal(manualPerformanceSchema.safeParse({ ...base, reach: "-1" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...base, reach: "1.5" }).success, false);
});

test("manual performance rejects impossible metric relationships and invalid dates/counts", () => {
  const valid = { observedOn: "2026-04-05", platform: "", impressions: "10", clicks: "8", conversions: "2", spendCents: "0", revenueCents: "0" };
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, clicks: "11" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, conversions: "9" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, observedOn: "bad" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, observedOn: "2026-02-30" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, spendCents: "-1" }).success, false);
});
