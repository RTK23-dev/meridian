import assert from "node:assert/strict";
import test from "node:test";
import { brainCompleteness, emptyBrain, slugify } from "./brain.ts";

test("an empty brain is not treated as understood", () => {
  const score = brainCompleteness(emptyBrain());
  assert.equal(score.filled, 0);
  assert.equal(score.ratio, 0);
});

test("completeness counts only written fields", () => {
  const brain = emptyBrain();
  brain.tone = "  dry  ";
  brain.positioning = "The quiet alternative";
  const score = brainCompleteness(brain);
  assert.equal(score.filled, 2);
  assert.ok(score.ratio > 0 && score.ratio < 1);
});

test("workspace slugs stay url-safe", () => {
  assert.equal(slugify("  North & Co.  "), "north-co");
  assert.equal(slugify("***"), "workspace");
});
