import assert from "node:assert/strict";
import test from "node:test";
import { JevDecision, ReviewerDecision, evaluateJevGate } from "./reviewer-decision.ts";

test("evaluateJevGate: blocks on REJECT regardless of reviewer decision", () => {
  assert.deepEqual(
    evaluateJevGate({ decision: JevDecision.REJECT }),
    { status: "BLOCK", reason: "JEV rejected the creative" }
  );

  // Even if reviewer had previously approved an older draft, JEV REJECT blocks
  assert.deepEqual(
    evaluateJevGate({ decision: "REJECT", reviewerDecision: "APPROVED" }),
    { status: "BLOCK", reason: "JEV rejected the creative" }
  );
});

test("evaluateJevGate: requires human approval on HUMAN_REVIEW unless explicitly approved", () => {
  // Pending reviewer decision
  assert.deepEqual(
    evaluateJevGate({ decision: JevDecision.HUMAN_REVIEW }),
    { status: "REQUIRE_HUMAN", reason: "Human approval required" }
  );

  // Approved by human reviewer (handles both canonical APPROVE and historical "approved")
  assert.deepEqual(
    evaluateJevGate({ decision: JevDecision.HUMAN_REVIEW, reviewerDecision: ReviewerDecision.APPROVE }),
    { status: "ALLOW" }
  );
  assert.deepEqual(
    evaluateJevGate({ decision: "HUMAN_REVIEW", reviewerDecision: "approved" }),
    { status: "ALLOW" }
  );

  // Rejected by human reviewer
  assert.deepEqual(
    evaluateJevGate({ decision: JevDecision.HUMAN_REVIEW, reviewerDecision: ReviewerDecision.REJECT }),
    { status: "BLOCK", reason: "Reviewer rejected the creative during human review" }
  );
  assert.deepEqual(
    evaluateJevGate({ decision: "HUMAN_REVIEW", reviewerDecision: "rejected" }),
    { status: "BLOCK", reason: "Reviewer rejected the creative during human review" }
  );
});

test("evaluateJevGate: allows APPROVE and AUTO_APPROVE", () => {
  assert.deepEqual(
    evaluateJevGate({ decision: JevDecision.APPROVE }),
    { status: "ALLOW" }
  );
  assert.deepEqual(
    evaluateJevGate({ decision: JevDecision.AUTO_APPROVE }),
    { status: "ALLOW" }
  );
  assert.deepEqual(
    evaluateJevGate({ decision: "approved" }),
    { status: "ALLOW" }
  );
});

test("evaluateJevGate: fails closed on unknown or invalid decision states", () => {
  assert.equal(evaluateJevGate({ decision: "" }).status, "BLOCK");
  assert.equal(evaluateJevGate({ decision: "UNKNOWN_STATE" }).status, "BLOCK");
});
