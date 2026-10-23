import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AssetJob } from "../assets/job.ts";
import type { AsyncAssetRouter, ProduceInput } from "../assets/router.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { waitingHoldsByNode } from "./holds.ts";
import { ASSET_POLL_AGAIN_MS, pollAssetJobs, queueAssetJob, sqlAssetPollStore, type AssetPollStore, type DueAsset } from "./asset-poll.ts";
import { createPlanDraft, failedHoldsByNode, failedHoldsUsd, listPlanEvents, listStepOutputs } from "./store.ts";

const JOB = { idempotencyKey: "job-1", jobRef: "provider-job-1" } as unknown as AssetJob;
const NEXT_JOB = { idempotencyKey: "job-1-retry", jobRef: "provider-job-2" } as unknown as AssetJob;
const INPUT = { spec: { shotId: "shot_0a", modelClass: "video.budget" }, requestId: "req_1", reservationId: "res_1" } as unknown as ProduceInput;

/** A due row as the poll reads it. The hold is recorded (0.8) unless a test says otherwise. */
function row(overrides: Partial<DueAsset> = {}): DueAsset {
  return {
    id: "row-1",
    planId: "plan-1",
    stepId: "clip",
    requestId: "req_1",
    reservationId: "res_1",
    cacheKey: "step-key",
    kind: "video",
    input: INPUT,
    job: JOB,
    heldUsd: 0.8,
    seconds: null,
    ...overrides,
  };
}

/** A store that records every write, so each test can read what the poll did. */
function fakeStore(due: DueAsset[]) {
  const writes = {
    rescheduled: [] as Array<{ id: string; job: AssetJob; runAfterMs: number }>,
    finished: [] as Array<{ id: string; status: string; result: string }>,
    outputs: [] as Array<{ planId: string; cacheKey: string; body: string | null; costUsd: number | null; category: string | null }>,
    measured: [] as Array<{ cacheKey: string; seconds: number; actualUsd: number }>,
    charged: [] as Array<{ id: string; hold: number | null }>,
  };
  const store: AssetPollStore = {
    async due() {
      return due;
    },
    async reschedule(id, change) {
      writes.rescheduled.push({ id, job: change.job, runAfterMs: change.runAfterMs });
    },
    async complete(r, output, result, measured) {
      writes.outputs.push({ planId: r.planId, cacheKey: r.cacheKey, body: output.body, costUsd: output.costUsd, category: output.category });
      writes.finished.push({ id: r.id, status: "done", result });
      if (measured !== null) writes.measured.push({ cacheKey: r.cacheKey, ...measured });
    },
    async fail(r, reason) {
      // As the database store does: a row with a recorded hold charges it as a failed event; a row with none writes no event.
      if (r.heldUsd !== null) writes.charged.push({ id: r.id, hold: r.heldUsd });
      writes.finished.push({ id: r.id, status: "failed", result: reason });
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

const DONE_WITH_BILL = { status: "done", asset: { providerId: "openrouter:video", modelClass: "video.budget", uri: "engine/org/req/video/a.mp4", cacheKey: "c", costUsd: 0.4, cacheHit: false } };

describe("the poll over recorded answers", () => {
  test("a job the provider is still working on is polled again later, keeps its hold, and stores nothing", async () => {
    const { store, writes } = fakeStore([row()]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "pending" } })) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: JOB, runAfterMs: ASSET_POLL_AGAIN_MS }]);
    assert.equal(writes.outputs.length, 0);
    assert.equal(writes.finished.length, 0);
    assert.equal(writes.charged.length, 0, "a working job's hold is not charged or released");
  });

  test("a finished job stores its output under the step's cache key at the reported bill, and closes the row as done", async () => {
    const { store, writes } = fakeStore([row()]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "engine/org/req/video/a.mp4" }, settle: DONE_WITH_BILL })) });
    assert.deepEqual(report, { polled: 1, done: 1, failed: 0, waiting: 0 });
    assert.deepEqual(writes.outputs, [{ planId: "plan-1", cacheKey: "step-key", body: "engine/org/req/video/a.mp4", costUsd: 0.4, category: "creative" }]);
    assert.deepEqual(writes.finished, [{ id: "row-1", status: "done", result: "stored" }]);
    assert.deepEqual(writes.measured, [], "a clip with no length is not measured");
  });

  test("a finished clip with a known length is measured at its reported bill", async () => {
    const { store, writes } = fakeStore([row({ seconds: 8 })]);
    await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: DONE_WITH_BILL })) });
    assert.deepEqual(writes.measured, [{ cacheKey: "step-key", seconds: 8, actualUsd: 0.4 }]);
  });

  test("a finished job with no reported bill is stored at its hold, never at null, and is not measured", async () => {
    const noBill = { status: "done", asset: { ...(DONE_WITH_BILL.asset as object), costUsd: null } };
    const { store, writes } = fakeStore([row({ seconds: 8 })]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: noBill })) });
    assert.deepEqual(report, { polled: 1, done: 1, failed: 0, waiting: 0 });
    assert.equal(writes.outputs[0]?.costUsd, 0.8, "the output is charged its hold");
    assert.match(writes.finished[0]?.result ?? "", /stored at its hold/);
    assert.deepEqual(writes.measured, [], "a hold is an estimate, so it is never measured");
  });

  test("a finished job with no reported bill and no recorded hold closes as failed, and stores nothing", async () => {
    const noBill = { status: "done", asset: { ...(DONE_WITH_BILL.asset as object), costUsd: null } };
    const { store, writes } = fakeStore([row({ heldUsd: null })]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: noBill })) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal(writes.outputs.length, 0);
    assert.equal(writes.charged.length, 0, "no hold was recorded, so there is no failed event to write");
    assert.match(writes.finished[0]?.result ?? "", /nothing is stored/);
  });

  test("a retry the router submits again replaces the row's job and waits for its own first poll", async () => {
    const submitted = { status: "submitted", job: NEXT_JOB, runAfterMs: 15_000 };
    const { store, writes } = fakeStore([row()]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "failed", error: { kind: "server", retryable: true, message: "503" } }, settle: submitted })) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: NEXT_JOB, runAfterMs: 15_000 }]);
    assert.equal(writes.outputs.length, 0);
  });

  test("a refused job closes its row as failed with the reason, charges its hold, and stores no output", async () => {
    const refused = { status: "failed", providerId: "openrouter:video", error: { kind: "content_policy", retryable: false, message: "policy" } };
    const { store, writes } = fakeStore([row()]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "failed", error: { kind: "content_policy", retryable: false, message: "policy" } }, settle: refused })) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal(writes.outputs.length, 0);
    assert.equal(writes.finished[0]?.status, "failed");
    assert.match(writes.finished[0]?.result ?? "", /refused the request/);
    assert.deepEqual(writes.charged, [{ id: "row-1", hold: 0.8 }]);
  });

  test("an unsettled submit names the operator, charges its hold, and never stores an output", async () => {
    const unsettled = { status: "unsettled", providerId: "openrouter:video", idempotencyKey: "job-1", ledgerEntryId: "e1", reason: "a server error with no job id" };
    const { store, writes } = fakeStore([row()]);
    await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: unsettled })) });
    assert.equal(writes.outputs.length, 0);
    assert.match(writes.finished[0]?.result ?? "", /operator settles it/);
    assert.deepEqual(writes.charged, [{ id: "row-1", hold: 0.8 }], "the submit may have been billed, so its hold stays counted");
  });

  test("a poll that throws closes a row with a hold as failed, charging the hold; the other rows still poll", async () => {
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
    assert.deepEqual(writes.charged, [{ id: "row-a", hold: 0.8 }]);
    assert.equal(writes.rescheduled[0]?.id, "row-b");
  });

  test("a poll that throws on a row with no recorded hold leaves the row open: its money is unknown, so it is not closed", async () => {
    const { store, writes } = fakeStore([row({ heldUsd: null })]);
    const router = { async pollOnce() { throw new Error("the provider was not reachable"); } } as unknown as AsyncAssetRouter;
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(router) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: JOB, runAfterMs: ASSET_POLL_AGAIN_MS }]);
    assert.equal(writes.finished.length, 0);
    assert.equal(writes.charged.length, 0);
  });
});

describe("the poll on the database: holds, bills, measurements and organizations (D14, D15)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
  });

  after(async () => {
    await db.close();
  });

  /** A workspace and a plan of its own, so each test reads only its own rows. */
  async function workspace(name: string): Promise<{ org: string; plan: string }> {
    const org = `org_poll_${name}`;
    const plan = `plan_poll_${name}`;
    await seedWorkspace(db.sql, org);
    await createPlanDraft(db.sql, { id: plan, organizationId: org, title: name, brief: {}, orchestratorModel: "orchestrator-test-model", budgetUsd: 5 });
    return { org, plan };
  }

  /** Queues one accepted job (queueAssetJob) and makes it due now, as the poll would find it. */
  async function queued(org: string, plan: string, options: { stepId?: string; cacheKey?: string; hold?: number; seconds?: number | null } = {}): Promise<string> {
    const cacheKey = options.cacheKey ?? `key-${globalThis.crypto.randomUUID()}`;
    await queueAssetJob(db.sql, org, {
      planId: plan,
      stepId: options.stepId ?? "clip",
      cacheKey,
      kind: "video",
      input: INPUT,
      job: JOB,
      runAfterMs: 60_000,
      hold: options.hold ?? 0.8,
      seconds: options.seconds === undefined ? 8 : options.seconds,
    });
    await db.sql`update orchestrator_asset_jobs set next_poll_at = now() - interval '1 minute' where organization_id = ${org} and cache_key = ${cacheKey}`;
    return cacheKey;
  }

  /** A row queued before migration 0117: no hold and no length were recorded. */
  async function legacyRow(org: string, plan: string, stepId: string): Promise<string> {
    const cacheKey = `legacy-${globalThis.crypto.randomUUID()}`;
    await db.sql`
      insert into orchestrator_asset_jobs (id, organization_id, plan_id, request_id, reservation_id, step_id, cache_key, kind, input, job, next_poll_at)
      values (${globalThis.crypto.randomUUID()}, ${org}, ${plan}, 'req_1', 'res_1', ${stepId}, ${cacheKey}, 'video',
        ${JSON.stringify(INPUT)}::jsonb, ${JSON.stringify(JOB)}::jsonb, now() - interval '1 minute')
    `;
    return cacheKey;
  }

  async function rowOf(org: string, cacheKey: string): Promise<{ status: string; result: string; held_usd: unknown; hold_usd: unknown; job: unknown }> {
    const rows = await db.sql<{ status: string; result: string; held_usd: unknown; hold_usd: unknown; job: unknown }>`
      select status, result, held_usd, hold_usd, job from orchestrator_asset_jobs where organization_id = ${org} and cache_key = ${cacheKey}
    `;
    const found = rows[0];
    assert.ok(found, `a row for ${cacheKey} exists`);
    return found;
  }

  async function measurementsOf(org: string, plan: string, cacheKey: string): Promise<Array<{ seconds: unknown; actual_usd: unknown }>> {
    return db.sql<{ seconds: unknown; actual_usd: unknown }>`
      select seconds, actual_usd from orchestrator_cost_measurements where organization_id = ${org} and plan_id = ${plan} and cache_key = ${cacheKey}
    `;
  }

  async function pollWith(org: string, router: AsyncAssetRouter) {
    return pollAssetJobs({ store: sqlAssetPollStore(db.sql, org), organizationId: org, routerFor: routerFor(router) });
  }

  test("a job still working keeps its hold counted, and its row stays waiting", async () => {
    const { org, plan } = await workspace("pending");
    const key = await queued(org, plan);
    assert.deepEqual(await pollWith(org, fakeRouter({ poll: { state: "pending" } })), { polled: 1, done: 0, failed: 0, waiting: 1 });
    const found = await rowOf(org, key);
    assert.equal(found.status, "waiting");
    assert.equal(Number(found.held_usd), 0.8, "the hold is unchanged");
    assert.equal((await waitingHoldsByNode(db.sql, org, plan)).byNode.get("clip"), 0.8);
  });

  test("a finished job is stored at its reported bill, measured once, and no longer holds money", async () => {
    const { org, plan } = await workspace("done");
    const key = await queued(org, plan, { seconds: 8 });
    const report = await pollWith(org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: { ...DONE_WITH_BILL, asset: { ...(DONE_WITH_BILL.asset as object), costUsd: 0.5 } } }));
    assert.deepEqual(report, { polled: 1, done: 1, failed: 0, waiting: 0 });
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key)?.costUsd, 0.5, "the output carries the reported bill");
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key)?.category, "creative");
    assert.equal((await rowOf(org, key)).status, "done");
    assert.deepEqual((await measurementsOf(org, plan, key)).map((m) => [Number(m.seconds), Number(m.actual_usd)]), [[8, 0.5]]);
    assert.equal((await waitingHoldsByNode(db.sql, org, plan)).byNode.size, 0, "the output replaces the hold");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0);
  });

  test("a second job for the same plan and cache key adds no second output and no second measurement", async () => {
    const { org, plan } = await workspace("twice");
    const key = `same-${globalThis.crypto.randomUUID()}`;
    await queued(org, plan, { cacheKey: key, seconds: 8 });
    await queued(org, plan, { cacheKey: key, seconds: 8 });
    const report = await pollWith(org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: DONE_WITH_BILL }));
    assert.deepEqual(report, { polled: 2, done: 2, failed: 0, waiting: 0 });
    assert.equal((await measurementsOf(org, plan, key)).length, 1, "one measurement per plan and cache key");
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key)?.costUsd, 0.4);
  });

  test("a finished job with no reported bill is stored at its hold, and is not measured", async () => {
    const { org, plan } = await workspace("nobill");
    const key = await queued(org, plan, { seconds: 8, hold: 0.8 });
    const noBill = { status: "done", asset: { ...(DONE_WITH_BILL.asset as object), costUsd: null } };
    await pollWith(org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: noBill }));
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key)?.costUsd, 0.8);
    assert.equal((await measurementsOf(org, plan, key)).length, 0);
    assert.equal((await rowOf(org, key)).status, "done");
  });

  test("a finished row with no reported bill and no recorded hold closes as failed, stores nothing, and writes no event", async () => {
    const { org, plan } = await workspace("legacy-done");
    const key = await legacyRow(org, plan, "legacy-clip");
    const noBill = { status: "done", asset: { ...(DONE_WITH_BILL.asset as object), costUsd: null } };
    const report = await pollWith(org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: noBill }));
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key), undefined);
    assert.equal((await rowOf(org, key)).status, "failed");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0);
  });

  test("a poll that throws closes a row with a hold as failed, and its hold counts in failedHoldsUsd", async () => {
    const { org, plan } = await workspace("threw");
    const key = await queued(org, plan, { stepId: "clip", hold: 0.8 });
    const report = await pollWith(org, fakeRouter({ poll: null, pollThrows: true }));
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal((await rowOf(org, key)).status, "failed");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0.8, "the hold counts as spent");
    assert.equal((await failedHoldsByNode(db.sql, org, plan)).get("clip"), 0.8);
    const events = await listPlanEvents(db.sql, org, plan, 0);
    assert.deepEqual(events.map((e) => [e.nodeId, e.state, e.costUsd, e.reason]), [["clip", "failed", 0.8, "the provider was not reachable"]]);
    assert.equal((await waitingHoldsByNode(db.sql, org, plan)).byNode.size, 0, "the failed row no longer holds money as waiting");
  });

  test("a poll that throws on a row with no recorded hold leaves it waiting, so its run refuses it", async () => {
    const { org, plan } = await workspace("legacy-threw");
    const key = await legacyRow(org, plan, "legacy-clip");
    const report = await pollWith(org, fakeRouter({ poll: null, pollThrows: true }));
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.equal((await rowOf(org, key)).status, "waiting");
    assert.deepEqual((await waitingHoldsByNode(db.sql, org, plan)).unrecorded, ["legacy-clip"]);
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0);
  });

  test("an unsettled submit closes its row as failed, and its hold stays counted", async () => {
    const { org, plan } = await workspace("unsettled");
    const key = await queued(org, plan, { hold: 0.8 });
    const unsettled = { status: "unsettled", providerId: "openrouter:video", idempotencyKey: "job-1", ledgerEntryId: "e1", reason: "a server error with no job id" };
    await pollWith(org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: unsettled }));
    assert.equal((await rowOf(org, key)).status, "failed");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0.8);
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key), undefined);
  });

  test("a retry adds its hold to the row's total once; a replayed settle of the same retry adds nothing", async () => {
    const { org, plan } = await workspace("retry");
    const key = await queued(org, plan, { stepId: "clip", hold: 0.8 });
    const retrying = fakeRouter({ poll: { state: "failed", error: { kind: "server", retryable: true, message: "503" } }, settle: { status: "submitted", job: NEXT_JOB, runAfterMs: 15_000 } });
    assert.deepEqual(await pollWith(org, retrying), { polled: 1, done: 0, failed: 0, waiting: 1 });
    let found = await rowOf(org, key);
    assert.equal(Number(found.held_usd), 1.6, "the second paid submit is held too");
    assert.equal(Number(found.hold_usd), 0.8, "hold_usd stays the hold of one submit");
    const stored = typeof found.job === "string" ? (JSON.parse(found.job) as { idempotencyKey: string }) : (found.job as { idempotencyKey: string });
    assert.equal(stored.idempotencyKey, "job-1-retry", "the row takes the retry's job");
    assert.equal((await waitingHoldsByNode(db.sql, org, plan)).byNode.get("clip"), 1.6);

    await db.sql`update orchestrator_asset_jobs set next_poll_at = now() - interval '1 minute' where cache_key = ${key}`;
    assert.deepEqual(await pollWith(org, retrying), { polled: 1, done: 0, failed: 0, waiting: 1 }, "the same retry is answered again");
    found = await rowOf(org, key);
    assert.equal(Number(found.held_usd), 1.6, "the same submit is not counted twice");
  });

  test("another organization's rows are never polled, and a write from another workspace changes nothing", async () => {
    const mine = await workspace("scope-mine");
    const theirs = await workspace("scope-theirs");
    const key = await queued(theirs.org, theirs.plan, { hold: 0.8 });

    assert.deepEqual(await pollWith(mine.org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: DONE_WITH_BILL })), { polled: 0, done: 0, failed: 0, waiting: 0 });

    const [foreign] = await sqlAssetPollStore(db.sql, theirs.org).due(10);
    assert.ok(foreign, "the other workspace sees its own row");
    await assert.rejects(sqlAssetPollStore(db.sql, mine.org).fail(foreign, "closed from the wrong workspace"), /not in this organization/);
    assert.equal((await rowOf(theirs.org, key)).status, "waiting", "the other workspace's row is unchanged");
    assert.equal(await failedHoldsUsd(db.sql, theirs.org, theirs.plan), 0);
  });
});
