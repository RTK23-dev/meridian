import assert from "node:assert/strict";
import test from "node:test";
import { patternClearsBeatFloor, winnerClearsFloor } from "./pick.ts";

test("a saved winner-score floor excludes a lower score, and no floor excludes nothing", () => {
  assert.equal(winnerClearsFloor(0.69, 0.7), false);
  assert.equal(winnerClearsFloor(0.7, 0.7), true);
  assert.equal(winnerClearsFloor(0.2, null), true);
});

test("a saved P(beat) floor excludes a lower measured probability and keeps a pattern that has none", () => {
  assert.equal(patternClearsBeatFloor(0.5, 0.8), false);
  assert.equal(patternClearsBeatFloor(0.8, 0.8), true);
  assert.equal(patternClearsBeatFloor(null, 0.8), true);
  assert.equal(patternClearsBeatFloor(0.1, null), true);
});
