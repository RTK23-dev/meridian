import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_POLL_MS, isActiveJobStatus, jobDetailRefetchInterval, jobsRefetchInterval } from "./polling.ts";

test("queued, running and retrying jobs are active; finished ones are not", () => {
  for (const status of ["queued", "running", "retry"]) assert.equal(isActiveJobStatus(status), true, status);
  for (const status of ["succeeded", "failed", "dead", "cancelled", "cancel_requested", ""]) assert.equal(isActiveJobStatus(status), false, status);
});

test("the jobs list polls every 5 seconds only while a row is active", () => {
  assert.equal(ACTIVE_POLL_MS, 5_000);
  assert.equal(jobsRefetchInterval({ jobs: [{ status: "succeeded" }, { status: "running" }] }), ACTIVE_POLL_MS);
  assert.equal(jobsRefetchInterval({ jobs: [{ status: "succeeded" }, { status: "dead" }] }), false);
  assert.equal(jobsRefetchInterval({ jobs: [] }), false, "an empty page does not poll");
  assert.equal(jobsRefetchInterval(undefined), false, "a list not loaded yet does not poll");
});

test("the job drawer polls only while its one job is active", () => {
  assert.equal(jobDetailRefetchInterval({ status: "retry" }), ACTIVE_POLL_MS);
  assert.equal(jobDetailRefetchInterval({ status: "failed" }), false);
  assert.equal(jobDetailRefetchInterval(undefined), false);
});
