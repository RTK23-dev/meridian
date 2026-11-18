import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, percentile, summarise } from "./load-check.mjs";

test("percentiles pick the sample at or above the rank", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 10);
  assert.equal(percentile([], 95), null);
});

test("a path passes only under its p95 limit and the error-rate limit, and an empty run fails", () => {
  const fast = Array.from({ length: 100 }, () => ({ ms: 10, ok: true }));
  assert.equal(summarise("health", fast).pass, true);
  const slow = Array.from({ length: 100 }, () => ({ ms: LIMITS.p95Ms.health + 1, ok: true }));
  assert.equal(summarise("health", slow).pass, false);
  const errors = Array.from({ length: 100 }, (_, i) => ({ ms: 10, ok: i >= 2 }));
  assert.equal(summarise("health", errors).pass, false);
  assert.equal(summarise("health", []).pass, false);
});
