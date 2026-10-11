import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_FIELDS, REQUIRED_BRAIN_KEYS, brainCompleteness, emptyBrain, type BrainKey } from "../../lib/meridian/brain.ts";
import { missingItems, nextBestAction, pipelineStages, type PipelineCounts } from "./pipeline.ts";

const EMPTY: PipelineCounts = {
  competitors: 0, documents: 0, observations: 0, creatives: 0, openOpportunities: 0, reviews: 0, patterns: 0, performanceRows: 0,
  decisions: 0, briefs: 0, decidedReviews: 0,
};

/** A brain with the given fields written, read through the same completeness count the overview uses. */
function brainWith(keys: readonly BrainKey[]) {
  const values = emptyBrain();
  for (const key of keys) values[key] = "written";
  return brainCompleteness(values);
}

const COMPLETE = brainWith(REQUIRED_BRAIN_KEYS);
// Only positioning is written. Target customers, tone and prohibited claims are still needed.
const ONE_REQUIRED = brainWith(["positioning"]);
const NO_OPTIONAL_LEFT = brainWith(BRAIN_FIELDS.filter((field) => !field.required).map((field) => field.key));
const NO_STAGES_DONE = { counts: EMPTY, operating: { generationRuns: 0, publishedTests: 0 } };

test("the decision and brief stages show their stored counts", () => {
  const stages = pipelineStages({ counts: { ...EMPTY, decisions: 3, briefs: 2 }, operating: { generationRuns: 0, publishedTests: 0 } });
  const decision = stages.find((stage) => stage.key === "decision");
  const brief = stages.find((stage) => stage.key === "brief");
  assert.deepEqual([decision?.count, decision?.unit], [3, "decisions"]);
  assert.deepEqual([brief?.count, brief?.unit], [2, "briefs"]);
});

test("the review stage is done from the stored decided count, not from a list", () => {
  const none = pipelineStages({ counts: { ...EMPTY, reviews: 1 }, operating: { generationRuns: 1, publishedTests: 0 } });
  assert.equal(none.find((stage) => stage.key === "review")?.state, "in_progress", "an open review waits, it is not decided");
  const decided = pipelineStages({ counts: { ...EMPTY, decidedReviews: 1 }, operating: { generationRuns: 1, publishedTests: 0 } });
  assert.equal(decided.find((stage) => stage.key === "review")?.state, "done");
});

test("the missing checklist reads the same counts", () => {
  const items = missingItems({ brain: COMPLETE, counts: EMPTY, operating: { generationRuns: 0 } });
  assert.ok(items.some((item) => item.text === "Generate a first creative"));
  assert.equal(missingItems({ brain: COMPLETE, counts: { ...EMPTY, observations: 1, openOpportunities: 1, performanceRows: 1 }, operating: { generationRuns: 1 } }).length, 0);
});

test("the checklist names the required fields that are still empty, and links to the brain", () => {
  const brainItem = missingItems({ brain: ONE_REQUIRED, counts: EMPTY, operating: { generationRuns: 0 } })
    .find((item) => item.text.startsWith("Complete the brand brain"));
  assert.equal(brainItem?.text, "Complete the brand brain. Still needed: Target customers, Tone, Prohibited claims");
  assert.equal(brainItem?.to, "/brands/$brandId/brain");
});

test("a brain with every required field is not on the checklist, even with optional fields empty", () => {
  const items = missingItems({ brain: COMPLETE, counts: EMPTY, operating: { generationRuns: 0 } });
  assert.equal(items.some((item) => item.text.startsWith("Complete the brand brain")), false);
});

test("filling every optional field does not pass the brain gate while a required field is empty", () => {
  const items = missingItems({ brain: NO_OPTIONAL_LEFT, counts: EMPTY, operating: { generationRuns: 0 } });
  assert.equal(
    items.find((item) => item.text.startsWith("Complete the brand brain"))?.text,
    "Complete the brand brain. Still needed: Positioning, Target customers, Tone, Prohibited claims",
  );
});

test("the next action is the brain until every required field has content, and it names what is missing", () => {
  const stages = pipelineStages(NO_STAGES_DONE);
  const action = nextBestAction({ brain: ONE_REQUIRED, stages, recommendation: null });
  assert.equal(action.title, "Complete the brand brain");
  assert.equal(action.body, "1 of 4 required fields have content. Still needed: Target customers, Tone, Prohibited claims. Recommendations cite these fields, so add only what you can confirm.");
  assert.equal(action.to, "/brands/$brandId/brain");
});

test("the pipeline proceeds once every required field has content, even with optional fields empty", () => {
  const stages = pipelineStages(NO_STAGES_DONE);
  const action = nextBestAction({ brain: COMPLETE, stages, recommendation: null });
  assert.notEqual(action.title, "Complete the brand brain");
  assert.equal(action.to, "/brands/$brandId/market", "the first stage that has not started");
});
