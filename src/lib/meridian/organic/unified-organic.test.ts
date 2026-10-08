import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOrganicOutlier } from "./control-sets.ts";
import { classifyComment, summarizeCommentIntents } from "./comments.ts";

test("evaluateOrganicOutlier identifies genuine outliers against creator and category baselines", () => {
  const result = evaluateOrganicOutlier({
    postViews: 1_200_000,
    creatorMedianViews: 200_000, // 6x creator median
    categoryMedianViews: 500_000, // 2.4x category median
  });

  assert.equal(result.isOutlier, true);
  assert.equal(result.creatorMultiplier, 6.0);
  assert.equal(result.categoryMultiplier, 2.4);
  assert.equal(result.evidenceBasis, "creator_and_category");
});

test("evaluateOrganicOutlier abstains when no baselines are available", () => {
  const result = evaluateOrganicOutlier({
    postViews: 5_000_000,
  });

  assert.equal(result.isOutlier, false);
  assert.equal(result.evidenceBasis, "insufficient_baseline");
  assert.match(result.reason, /Cannot classify as outlier/);
});

test("classifyComment correctly extracts buyer intent", () => {
  const q = classifyComment({ id: "c1", text: "Does this work on sensitive skin?" });
  assert.equal(q.intent, "question");

  const obj = classifyComment({ id: "c2", text: "Way too expensive for a small bottle." });
  assert.equal(obj.intent, "objection");

  const des = classifyComment({ id: "c3", text: "Take my money, I need this immediately!" });
  assert.equal(des.intent, "desire");

  const conf = classifyComment({ id: "c4", text: "Wait what is step 2? I don't get it" });
  assert.equal(conf.intent, "confusion");

  const proof = classifyComment({ id: "c5", text: "Can confirm, it actually works!" });
  assert.equal(proof.intent, "social_proof");
});

test("summarizeCommentIntents aggregates categorized comments", () => {
  const comments = [
    { id: "1", text: "Does this work?" },
    { id: "2", text: "Too expensive" },
    { id: "3", text: "Need this!" },
    { id: "4", text: "Nice video" },
  ];

  const summary = summarizeCommentIntents(comments);
  assert.equal(summary.totalAnalyzed, 4);
  assert.equal(summary.questions.length, 1);
  assert.equal(summary.objections.length, 1);
  assert.equal(summary.desires.length, 1);
});
