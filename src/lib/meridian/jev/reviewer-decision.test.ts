import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewerDecision } from "./reviewer-decision.ts";

test("normalizes persisted reviewer actions for approval gates", () => {
  assert.equal(normalizeReviewerDecision("approve"), "approved");
  assert.equal(normalizeReviewerDecision("approved"), "approved");
  assert.equal(normalizeReviewerDecision("reject"), "rejected");
  assert.equal(normalizeReviewerDecision("rejected"), "rejected");
  assert.equal(normalizeReviewerDecision("revision"), "");
  assert.equal(normalizeReviewerDecision(null), "");
});
