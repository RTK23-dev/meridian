import assert from "node:assert/strict";
import test from "node:test";
import { confidenceClearsFloor, patternClearsBeatFloor, retentionClearsFloor, winnerClearsFloor } from "./pick.ts";

test("a saved winner-score floor excludes a lower score, and no floor excludes nothing", () => {
  assert.equal(winnerClearsFloor(0.69, 0.7), false);
  assert.equal(winnerClearsFloor(0.7, 0.7), true);
  assert.equal(winnerClearsFloor(0.2, null), true);
});

test("a saved confidence floor excludes a less sure decode and keeps one that recorded no confidence", () => {
  assert.equal(confidenceClearsFloor(0.4, 0.65), false);
  assert.equal(confidenceClearsFloor(0.65, 0.65), true);
  assert.equal(confidenceClearsFloor(null, 0.65), true);
});

test("a saved P(beat) floor excludes a lower measured probability and keeps a pattern that has none", () => {
  assert.equal(patternClearsBeatFloor(0.5, 0.8), false);
  assert.equal(patternClearsBeatFloor(0.8, 0.8), true);
  assert.equal(patternClearsBeatFloor(null, 0.8), true);
  assert.equal(patternClearsBeatFloor(0.1, null), true);
});

test("a 3 second retention floor ignores only a low retention measurement", () => {
  assert.equal(retentionClearsFloor("retention_3s", 0.2, 0.45), false);
  assert.equal(retentionClearsFloor("retention_3s", 0.45, 0.45), true);
  assert.equal(retentionClearsFloor("retention_3s", null, 0.45), true);
  assert.equal(retentionClearsFloor("ctr", 0.01, 0.45), true);
  assert.equal(retentionClearsFloor("retention_3s", 0.1, null), true);
});
