// The rules of a batch of videos (prompt 15), pure: each item's state comes from the engine's own status, a retry is allowed only for a failed
// item with attempts left, the committed spend counts only the items the engine took, and a batch budget is a hard limit.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineRequestStatus } from "../../../engine/api/index.ts";
import { committedUsd, fitsBatchBudget, itemStateOf, MAX_ITEM_ATTEMPTS, type BatchItemFacts } from "./batch.ts";

const draft: BatchItemFacts = { sessionStatus: "draft", revision: 0, lastRefusal: [], engine: null };
const started = (engine: EngineRequestStatus | null, revision = 0): BatchItemFacts => ({ sessionStatus: "started", revision, lastRefusal: [], engine });

test("a draft with no refusal is ready; a draft whose last start was refused is blocked, with the reason", () => {
  assert.deepEqual(itemStateOf(draft).state, "ready");
  const refused = itemStateOf({ ...draft, lastRefusal: ["The brief is missing."] });
  assert.equal(refused.state, "blocked");
  assert.match(refused.reason, /Not started: The brief is missing\./);
  assert.equal(refused.retryable, false);
});

test("each engine status maps to its own state, and a started video with no engine status is blocked, never working", () => {
  assert.equal(itemStateOf(started({ status: "queued", requestId: "r" })).state, "queued");
  assert.equal(itemStateOf(started({ status: "running", requestId: "r", stage: "render" })).reason, "Working now (at render).");
  const review = itemStateOf(started({ status: "needs_review", requestId: "r", stage: "plan", reason: "the plan needs a person", openItems: 2 }));
  assert.equal(review.state, "awaiting_review");
  assert.match(review.reason, /^2 open review items: the plan needs a person/);
  assert.equal(itemStateOf(started({ status: "delivered", requestId: "r", manifestId: "m" })).state, "delivered");
  assert.equal(itemStateOf(started(null)).state, "blocked", "no engine status is not shown as working");
});

test("a paused video is blocked: a budget pause says so, and a dead letter says a job failed for good", () => {
  const budget = itemStateOf(started({ status: "paused", requestId: "r", pauseKind: "budget", stage: "plan", reason: "the reservation is short" }));
  assert.equal(budget.state, "blocked");
  assert.match(budget.reason, /Waiting on the budget/);
  const dead = itemStateOf(started({ status: "paused", requestId: "r", pauseKind: "dead_letter", stage: "render", reason: "retries used up" }));
  assert.equal(dead.state, "blocked");
  assert.match(dead.reason, /failed for good/);
});

test("a failed video is retryable while attempts are left, and failed once none are left", () => {
  const failed: EngineRequestStatus = { status: "failed", requestId: "r", reasons: ["brand_claim: the claim is not allowed"] };
  const first = itemStateOf(started(failed, 0));
  assert.equal(first.state, "retryable");
  assert.equal(first.retryable, true);
  assert.equal(first.attempts, 1);
  assert.match(first.reason, /brand_claim/);
  const last = itemStateOf(started(failed, MAX_ITEM_ATTEMPTS - 1));
  assert.equal(last.state, "failed", "the last attempt has failed: no retry is offered");
  assert.equal(last.retryable, false);
  assert.match(last.reason, /No attempts are left/);
});

test("the committed spend counts only the items the engine took, and an item with no budget adds nothing", () => {
  assert.equal(committedUsd([{ started: true, budgetUsd: 10 }, { started: false, budgetUsd: 25 }, { started: true, budgetUsd: null }, { started: true, budgetUsd: 5 }]), 15);
});

test("a batch budget is a hard limit: an item that fits starts, one that would pass the budget does not, and an item with no budget is refused", () => {
  assert.deepEqual(fitsBatchBudget({ batchBudgetUsd: 20, committedUsd: 10, itemBudgetUsd: 10 }), { ok: true }, "exactly the budget fits");
  const over = fitsBatchBudget({ batchBudgetUsd: 20, committedUsd: 10, itemBudgetUsd: 10.01 });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.overBudget, true);
  assert.match(over.ok === false ? over.reason : "", /past its budget of \$20\.00/);
  const unbounded = fitsBatchBudget({ batchBudgetUsd: 20, committedUsd: 0, itemBudgetUsd: null });
  assert.equal(unbounded.ok, false);
  assert.equal(unbounded.ok === false && unbounded.overBudget, false, "an unbounded item is refused without stopping the batch");
});
