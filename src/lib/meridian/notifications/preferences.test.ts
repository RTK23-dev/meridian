import assert from "node:assert/strict";
import test from "node:test";
import { resolveNotificationPreferences } from "./preferences.ts";

test("notification preferences default to enabled and preserve saved per-kind choices", () => {
  const preferences = resolveNotificationPreferences(new Map([["review.required", false], ["learning.update", true]]));
  assert.equal(preferences.length, 4);
  assert.equal(preferences.find((item) => item.kind === "review.required")?.enabled, false);
  assert.equal(preferences.find((item) => item.kind === "learning.update")?.enabled, true);
  assert.equal(preferences.find((item) => item.kind === "performance.recorded")?.enabled, true);
});
