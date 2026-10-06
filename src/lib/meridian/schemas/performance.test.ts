import assert from "node:assert/strict";
import test from "node:test";
import { manualPerformanceSchema } from "./performance.ts";

test("manual performance accepts whole-number metrics and defaults optional reach", () => {
  const result = manualPerformanceSchema.parse({ observedOn: "2026-04-05", platform: "Meta", impressions: "100", clicks: "8", conversions: "2", spendCents: "500", revenueCents: "1000" });
  assert.equal(result.impressions, 100);
  assert.equal(result.reach, 0);
});

test("manual performance rejects impossible metric relationships and invalid dates/counts", () => {
  const valid = { observedOn: "2026-04-05", platform: "", impressions: "10", clicks: "8", conversions: "2", spendCents: "0", revenueCents: "0" };
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, clicks: "11" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, conversions: "9" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, observedOn: "bad" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, observedOn: "2026-02-30" }).success, false);
  assert.equal(manualPerformanceSchema.safeParse({ ...valid, spendCents: "-1" }).success, false);
});
