import assert from "node:assert/strict";
import test from "node:test";
import { describeFormat, formatFromPatterns, MIN_PATTERN_SAMPLES, MIN_RESEARCH_CORPUS, plainLabel, researchAngles, type StoredPattern } from "./research-format.ts";

const pattern = (dimension: string, value: string, sampleCount: number, corpusSize = 9): StoredPattern => ({ dimension, value, sampleCount, corpusSize, prevalence: sampleCount / corpusSize, confidence: 0.8 });

const PATTERNS = [
  pattern("structure", "problem_solution", 4),
  pattern("structure", "listicle", 2),
  pattern("structure", "before_after", 1),
  pattern("structure", "unclear", 5),
  pattern("openingMove", "question", 3),
  pattern("openingMove", "problem", 2),
  pattern("hookMechanism", "pain_point", 4),
  pattern("cta", "learn_more", 3),
  pattern("cta", "none", 6),
  pattern("topic", "kitchen sponges", 7),
];

test("the format needs enough analyzed ads and a structure that repeats, and says why when it has neither", () => {
  const few = formatFromPatterns([pattern("structure", "listicle", 2, 2)]);
  assert.equal(few.ok, false);
  assert.match(few.ok ? "" : few.reason, new RegExp(`at least ${MIN_RESEARCH_CORPUS}`));
  const none = formatFromPatterns([pattern("structure", "listicle", 1, 8), pattern("structure", "story_payoff", 1, 8)]);
  assert.equal(none.ok, false);
  assert.match(none.ok ? "" : none.reason, new RegExp(`at least ${MIN_PATTERN_SAMPLES}`));
  assert.equal(formatFromPatterns([]).ok, false);
});

test("only repeated, named labels count: unclear, other, none, one-off and free-text topics are left out, most common first", () => {
  const outcome = formatFromPatterns(PATTERNS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.format.structures.map((item) => item.value), ["problem_solution", "listicle"]);
  assert.deepEqual(outcome.format.openings.map((item) => item.value), ["question", "problem"]);
  assert.deepEqual(outcome.format.hooks.map((item) => item.value), ["pain_point"]);
  assert.deepEqual(outcome.format.ctas.map((item) => item.value), ["learn_more"]);
  assert.equal(outcome.format.corpusSize, 9);
  assert.deepEqual(describeFormat(outcome.format)[0], "Structure: problem solution (4 of 9), listicle (2 of 9)");
  assert.equal(plainLabel("before_after"), "before after");
});

test("research angles are distinct, most common first, name only label words and counts, and stop when the research does", () => {
  const outcome = formatFromPatterns(PATTERNS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const angles = researchAngles(outcome.format, 20);
  assert.equal(angles.length, 4, "two structures times two openings");
  assert.equal(new Set(angles.map((angle) => angle.id)).size, 4);
  assert.ok(angles.every((angle) => /^res_[0-9a-f]{10}$/.test(angle.id) && angle.id.length <= 40));
  assert.equal(angles[0]?.label, "Problem solution, question opening");
  assert.match(angles[0]?.focus ?? "", /problem solution structure \(found in 4 of 9 analyzed ads\)/);
  assert.match(angles[0]?.focus ?? "", /not proof of what works/);
  assert.equal(researchAngles(outcome.format, 2).length, 2);
  const same = researchAngles(outcome.format, 4).map((angle) => angle.id);
  assert.deepEqual(same, angles.map((angle) => angle.id), "the same research always gives the same angles");
});

test("a structure with no repeated opening still gives an angle", () => {
  const outcome = formatFromPatterns([pattern("structure", "story_payoff", 3), pattern("structure", "demonstration", 2)]);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const angles = researchAngles(outcome.format, 5);
  assert.deepEqual(angles.map((angle) => angle.label), ["Story payoff", "Demonstration"]);
});
