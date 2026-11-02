import assert from "node:assert/strict";
import test from "node:test";
import { RUBRIC_NAME_MAX, rubricNameProblem } from "./governance.ts";

test("a rubric name must be given, and is checked after trimming against its limit", () => {
  assert.equal(rubricNameProblem(""), "Give the rubric a name.");
  assert.equal(rubricNameProblem("   "), "Give the rubric a name.");
  assert.equal(rubricNameProblem("Hook strength"), null);
  assert.equal(rubricNameProblem(`  ${"n".repeat(RUBRIC_NAME_MAX)}  `), null, "the padding does not count");
  assert.equal(
    rubricNameProblem("n".repeat(RUBRIC_NAME_MAX + 1)),
    `The rubric name is longer than ${RUBRIC_NAME_MAX} characters.`,
  );
});
