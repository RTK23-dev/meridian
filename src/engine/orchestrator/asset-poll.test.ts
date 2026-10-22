import assert from "node:assert/strict";
import test from "node:test";
import type { AssetJob } from "../assets/job.ts";
import type { AsyncAssetRouter, ProduceInput } from "../assets/router.ts";
import { ASSET_POLL_AGAIN_MS, pollAssetJobs, type AssetPollStore, type DueAsset } from "./asset-poll.ts";

const JOB = { idempotencyKey: "job-1", jobRef: "provider-job-1" } as unknown as AssetJob;
const NEXT_JOB = { idempotencyKey: "job-1-retry", jobRef: "provider-job-2" } as unknown as AssetJob;
const INPUT = { spec: { shotId: "shot_0a", modelClass: "video.budget" }, requestId: "req_1", reservationId: "res_1" } as unknown as ProduceInput;

function row(overrides: Partial<DueAsset> = {}): DueAsset {
  return {
    id: "row-1",
    planId: "plan-1",
    requestId: "req_1",
    reservationId: "res_1",
    cacheKey: "step-key",
    kind: "video",
    input: INPUT,
    job: JOB,
    ...overrides,
  };
}

/** A store that records every write, so each test can read what the poll did. */
function fakeStore(due: DueAsset[]) {
  const writes = { rescheduled: [] as Array<{ id: string; job: AssetJob; runAfterMs: number }>, finished: [] as Array<{ id: string; status: string; result: string }>, outputs: [] as Array<{ planId: string; cacheKey: string; body: string | null; costUsd: number | null }> };
  const store: AssetPollStore = {
    async due() {
      return due;
    },
    async reschedule(id, change) {
      writes.rescheduled.push({ id, job: change.job, runAfterMs: change.runAfterMs });
    },
    async finish(id, status, result) {
      writes.finished.push({ id, status, result });
    },
    async putOutput(planId, cacheKey, output) {
      writes.outputs.push({ planId, cacheKey, body: output.body, costUsd: output.costUsd });
    },
  };
  return { store, writes };
}

/** A router whose poll and settle answers the test chooses. */
function fakeRouter(answers: { poll: unknown; settle?: unknown; pollThrows?: boolean }): AsyncAssetRouter {
  return {
    async pollOnce() {
      if (answers.pollThrows) throw new Error("the provider was not reachable");
      return answers.poll as never;
    },
    async settle() {
      return { step: answers.settle as never, decisions: [], alerts: [], attempts: [] };
    },
    async submit() {
      throw new Error("the poll never submits on its own");
    },
    async produce() {
      throw new Error("the poll never waits on its own");
    },
  } as unknown as AsyncAssetRouter;
}

const routerFor = (router: AsyncAssetRouter) => () => router;

test("a job the provider is still working on is polled again later, and stores nothing", async () => {
  const { store, writes } = fakeStore([row()]);
  const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "pending" } })) });
  assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
  assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: JOB, runAfterMs: ASSET_POLL_AGAIN_MS }]);
  assert.equal(writes.outputs.length, 0);
  assert.equal(writes.finished.length, 0);
});

test("a finished job stores its output under the step's cache key and closes the row as done", async () => {
  const done = { status: "done", asset: { providerId: "openrouter:video", modelClass: "video.budget", uri: "engine/org/req/video/a.mp4", cacheKey: "c", costUsd: 0.4, cacheHit: false } };
  const { store, writes } = fakeStore([row()]);
  const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "engine/org/req/video/a.mp4" }, settle: done })) });
  assert.deepEqual(report, { polled: 1, done: 1, failed: 0, waiting: 0 });
  assert.deepEqual(writes.outputs, [{ planId: "plan-1", cacheKey: "step-key", body: "engine/org/req/video/a.mp4", costUsd: 0.4 }]);
  assert.deepEqual(writes.finished, [{ id: "row-1", status: "done", result: "stored" }]);
});

test("a retry the router submits again replaces the row's job and waits for its own first poll", async () => {
  const submitted = { status: "submitted", job: NEXT_JOB, runAfterMs: 15_000 };
  const { store, writes } = fakeStore([row()]);
  const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "failed", error: { kind: "server", retryable: true, message: "503" } }, settle: submitted })) });
  assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
  assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: NEXT_JOB, runAfterMs: 15_000 }]);
  assert.equal(writes.outputs.length, 0);
});

test("a refused job closes its row as failed with the reason, and stores no output", async () => {
  const refused = { status: "failed", providerId: "openrouter:video", error: { kind: "content_policy", retryable: false, message: "policy" } };
  const { store, writes } = fakeStore([row()]);
  const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "failed", error: { kind: "content_policy", retryable: false, message: "policy" } }, settle: refused })) });
  assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
  assert.equal(writes.outputs.length, 0);
  assert.equal(writes.finished[0]?.status, "failed");
  assert.match(writes.finished[0]?.result ?? "", /refused the request/);
});

test("an unsettled submit names the operator and never stores an output", async () => {
  const unsettled = { status: "unsettled", providerId: "openrouter:video", idempotencyKey: "job-1", ledgerEntryId: "e1", reason: "a server error with no job id" };
  const { store, writes } = fakeStore([row()]);
  await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: unsettled })) });
  assert.equal(writes.outputs.length, 0);
  assert.match(writes.finished[0]?.result ?? "", /operator settles it/);
});

test("a poll that throws closes its row as failed, and the other rows still poll", async () => {
  const { store, writes } = fakeStore([row({ id: "row-a" }), row({ id: "row-b", cacheKey: "other" })]);
  let call = 0;
  const router = {
    async pollOnce() {
      call += 1;
      if (call === 1) throw new Error("the provider was not reachable");
      return { state: "pending" };
    },
    async settle() {
      throw new Error("unused");
    },
  } as unknown as AsyncAssetRouter;
  const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(router) });
  assert.deepEqual(report, { polled: 2, done: 0, failed: 1, waiting: 1 });
  assert.deepEqual(writes.finished, [{ id: "row-a", status: "failed", result: "the provider was not reachable" }]);
  assert.equal(writes.rescheduled[0]?.id, "row-b");
});
