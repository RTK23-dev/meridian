import assert from "node:assert/strict";
import test from "node:test";
import { performanceScheduleSchema } from "./performance-schedule.ts";

const valid = { provider: "meta", creativeId: "creative-1", externalAdId: "ad-1", currency: "usd", timezone: "UTC", startDate: "2026-01-01", endDate: "2026-01-31", everySeconds: "3600" };

test("performance schedule normalizes currency and cadence", () => {
  const parsed = performanceScheduleSchema.parse(valid);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.everySeconds, 3600);
});

test("performance schedule rejects invalid ids, cadence, and date order", () => {
  assert.equal(performanceScheduleSchema.safeParse({ ...valid, creativeId: "" }).success, false);
  assert.equal(performanceScheduleSchema.safeParse({ ...valid, everySeconds: "1" }).success, false);
  assert.equal(performanceScheduleSchema.safeParse({ ...valid, endDate: "2025-12-31" }).success, false);
  assert.equal(performanceScheduleSchema.safeParse({ ...valid, startDate: "2026-02-30" }).success, false);
});
