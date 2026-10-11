import assert from "node:assert/strict";
import test from "node:test";
import { MAX_STORAGE_PERSISTENCE_ATTEMPTS, storageRetryAction } from "./poller.ts";

test("a render that cannot be stored is retried, and the retries are bounded", () => {
  let attempts = 0;
  const decisions: string[] = [];
  for (let i = 0; i < MAX_STORAGE_PERSISTENCE_ATTEMPTS + 2; i += 1) {
    const decision = storageRetryAction(attempts);
    decisions.push(decision.action);
    attempts = decision.attempts;
  }
  const failedAt = decisions.indexOf("fail");
  assert.ok(failedAt >= 0, "the job is failed once retries run out");
  assert.equal(failedAt, MAX_STORAGE_PERSISTENCE_ATTEMPTS - 1, "the job fails on the last permitted attempt");
  assert.ok(decisions.slice(0, failedAt).every((action) => action === "retry"));
});

test("the bound is at least two attempts, so one transient storage fault does not fail a job", () => {
  assert.ok(MAX_STORAGE_PERSISTENCE_ATTEMPTS >= 2);
  assert.equal(storageRetryAction(0).action, "retry");
});
