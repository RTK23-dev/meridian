import assert from "node:assert/strict";
import test from "node:test";
import { missingItems, pipelineStages, type PipelineCounts } from "./pipeline.ts";

const EMPTY: PipelineCounts = {
  competitors: 0, documents: 0, observations: 0, creatives: 0, openOpportunities: 0, reviews: 0, patterns: 0, performanceRows: 0,
  decisions: 0, briefs: 0, decidedReviews: 0,
};

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
  const items = missingItems({ brainFilled: 10, counts: EMPTY, operating: { generationRuns: 0 } });
  assert.ok(items.some((item) => item.text === "Generate a first creative"));
  assert.equal(missingItems({ brainFilled: 10, counts: { ...EMPTY, observations: 1, openOpportunities: 1, performanceRows: 1 }, operating: { generationRuns: 1 } }).length, 0);
});
