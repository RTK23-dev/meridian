import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { authorizeCall } from "../budget/reserve.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { memoryLedgerStore } from "../budget/store.ts";
import type { AssetJob } from "../assets/job.ts";
import type { AsyncAssetRouter, ProduceInput } from "../assets/router.ts";
import { EngineError } from "../contracts/errors.ts";
import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { waitingHoldsByNode } from "./holds.ts";
import { ASSET_POLL_AGAIN_MS, RUN_ENDED_REASON, pollAssetJobs, queueAssetJob, sqlAssetPollStore, type AssetPollStore, type DueAsset } from "./asset-poll.ts";
import { createPlanDraft, failedHoldsByNode, failedHoldsUsd, listPlanEvents, listStepOutputs } from "./store.ts";
import { writeBrandPolicy } from "./brand-policy.ts";
import { writeOrchestratorPolicy } from "./policy-store.ts";

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
    holdUsd: 0.8,
    seconds: null,
    ...overrides,
  };
}

/** A store that records every write, so each test can read what the poll did. `families` are the plan's switched-off families at the poll. */
function fakeStore(due: DueAsset[], families: string[] = []) {
  const writes = {
    rescheduled: [] as Array<{ id: string; job: AssetJob; runAfterMs: number }>,
    finished: [] as Array<{ id: string; status: string; result: string }>,
    outputs: [] as Array<{ planId: string; cacheKey: string; body: string | null; costUsd: number | null; category: string | null }>,
    measured: [] as Array<{ cacheKey: string; seconds: number; actualUsd: number }>,
    charged: [] as Array<{ id: string; usd: number }>,
    overshoots: [] as Array<{ id: string; usd: number }>,
  };
  const store: AssetPollStore = {
    async due() {
      return due;
    },
    async reschedule(id, change) {
      writes.rescheduled.push({ id, job: change.job, runAfterMs: change.runAfterMs });
      if (change.overshootUsd > 0) writes.overshoots.push({ id, usd: change.overshootUsd });
    },
    async complete(r, output, result, measured) {
      writes.outputs.push({ planId: r.planId, cacheKey: r.cacheKey, body: output.body, costUsd: output.costUsd, category: output.category });
      writes.finished.push({ id: r.id, status: "done", result });
      if (measured !== null) writes.measured.push({ cacheKey: r.cacheKey, ...measured });
      return true;
    },
    async fail(r, reason, chargeUsd) {
      // The charge the poll decided, as the database store writes it: one failed event for it.
      writes.charged.push({ id: r.id, usd: chargeUsd });
      writes.finished.push({ id: r.id, status: "failed", result: reason });
      return true;
    },
    async disabledFamiliesOf() {
      // The families as they are at the poll: the test changes this list to switch a family off after the row was queued.
      return families;
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

  test("a finished job with no reported bill and no recorded hold stays open: its money is unknown, so it is never closed as zero", async () => {
    const noBill = { status: "done", asset: { ...(DONE_WITH_BILL.asset as object), costUsd: null } };
    const { store, writes } = fakeStore([row({ heldUsd: null })]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: noBill })) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: JOB, runAfterMs: ASSET_POLL_AGAIN_MS }]);
    assert.equal(writes.outputs.length, 0, "nothing is stored: there is no bill and no hold to store");
    assert.equal(writes.finished.length, 0, "the row is not closed");
    assert.equal(writes.charged.length, 0, "no hold was recorded, so there is no failed event to write");
  });

  test("a row with no recorded hold that the provider answers as failed, refused or unsettled stays open, and a released run's refusal too", async () => {
    const refused = { status: "failed", providerId: "openrouter:video", error: { kind: "content_policy", retryable: false, message: "policy" } };
    const unsettled = { status: "unsettled", providerId: "openrouter:video", idempotencyKey: "job-1", ledgerEntryId: "e1", reason: "a server error with no job id" };
    const runEnded = { status: "unavailable", reasons: ["openrouter:video: reservation res_1 is released; no call is made"] };
    for (const settle of [refused, unsettled, runEnded]) {
      const { store, writes } = fakeStore([row({ heldUsd: null })]);
      const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle })) });
      assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 }, JSON.stringify(settle));
      assert.equal(writes.finished.length, 0, "the row is not closed, so its unknown money is not closed as zero");
      assert.equal(writes.charged.length, 0);
      assert.equal(writes.outputs.length, 0);
    }
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
    assert.deepEqual(writes.charged, [{ id: "row-1", usd: 0.8 }]);
  });

  test("an unsettled submit names the operator, charges its hold, and never stores an output", async () => {
    const unsettled = { status: "unsettled", providerId: "openrouter:video", idempotencyKey: "job-1", ledgerEntryId: "e1", reason: "a server error with no job id" };
    const { store, writes } = fakeStore([row()]);
    await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: unsettled })) });
    assert.equal(writes.outputs.length, 0);
    assert.match(writes.finished[0]?.result ?? "", /operator settles it/);
    assert.deepEqual(writes.charged, [{ id: "row-1", usd: 0.8 }], "the submit may have been billed, so its hold stays counted");
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
    assert.deepEqual(writes.charged, [{ id: "row-a", usd: 0.8 }]);
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

  test("a retry the router refuses because its run's reservation is released closes the row as failed, charges its hold, and names the new run", async () => {
    // The router's answer when the retry is refused: its reasons name the refusal the budget gave (budget/reserve.ts).
    const refused = { status: "unavailable", reasons: ["openrouter:video: rate_limit: 429", "openrouter:video: reservation res_1 is released; no call is made"] };
    const { store, writes } = fakeStore([row()]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: refused })) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.deepEqual(writes.finished, [{ id: "row-1", status: "failed", result: RUN_ENDED_REASON }]);
    assert.deepEqual(writes.charged, [{ id: "row-1", usd: 0.8 }], "the job's hold is charged once, as a failed hold");
    assert.equal(writes.outputs.length, 0);
  });

  test("a refusal for another reason keeps the router's own reason: only a released run's refusal names the new run", async () => {
    const refused = { status: "refused", reasons: ["openrouter:video: the request has committed 5 USD, at or above its 5 USD budget, so no paid call starts"] };
    const { store, writes } = fakeStore([row()]);
    await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: refused })) });
    assert.match(writes.finished[0]?.result ?? "", /the budget refused this video/);
    assert.notEqual(writes.finished[0]?.result, RUN_ENDED_REASON);
  });

  test("a close that writes nothing, because another poll closed the row first, is not counted in the report", async () => {
    const { store } = fakeStore([row()]);
    const closedElsewhere: AssetPollStore = { ...store, async complete() { return false; }, async fail() { return false; } };
    const done = await pollAssetJobs({ store: closedElsewhere, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: DONE_WITH_BILL })) });
    assert.deepEqual(done, { polled: 1, done: 0, failed: 0, waiting: 0 }, "a completed close that wrote nothing is not counted");
    const failed = await pollAssetJobs({ store: closedElsewhere, organizationId: "org_1", routerFor: routerFor(fakeRouter({ poll: null, pollThrows: true })) });
    assert.deepEqual(failed, { polled: 1, done: 0, failed: 0, waiting: 0 }, "a failed close that wrote nothing is not counted");
  });

  test("a family switched off after the job was queued is not picked by the poll's settle-time fallback: the router that settles it is built with the families as they are now", async () => {
    // The job's fallbacks, in order: a target in "vendor-x", then one in "vendor-c". The router picks the first fallback whose family is not
    // switched off in the scope it is built with (the settle-time check of the router, which the poll now feeds).
    const fallbacks = [
      { id: "target-x", family: "vendor-x" },
      { id: "target-c", family: "vendor-c" },
    ];
    const settledWith: Array<readonly string[]> = [];
    const routerFor = (scope: { disabledFamilies: readonly string[] }): AsyncAssetRouter => {
      settledWith.push(scope.disabledFamilies);
      const next = fallbacks.find((target) => !scope.disabledFamilies.includes(target.family));
      return {
        async pollOnce() {
          return { state: "failed", error: { kind: "server", retryable: true, message: "503" } };
        },
        async settle() {
          const step =
            next === undefined
              ? { status: "unavailable", reasons: ["no fallback is left in a family that is on"] }
              : { status: "submitted", job: { ...NEXT_JOB, targetId: next.id }, runAfterMs: 15_000 };
          return { step, decisions: [], alerts: [], attempts: [] };
        },
      } as unknown as AsyncAssetRouter;
    };
    const targetOf = (job: AssetJob | undefined): unknown => (job as unknown as { targetId?: string } | undefined)?.targetId;

    // Polled while no family is switched off, the fallback is the first target.
    const beforeSwitch = fakeStore([row()]);
    await pollAssetJobs({ store: beforeSwitch.store, organizationId: "org_1", routerFor });
    assert.equal(targetOf(beforeSwitch.writes.rescheduled[0]?.job), "target-x", "with no family switched off, the fallback is the first target");

    // The same job, polled after "vendor-x" was switched off: its fallback is the next target, never the switched-off one.
    const afterSwitch = fakeStore([row()], ["vendor-x"]);
    await pollAssetJobs({ store: afterSwitch.store, organizationId: "org_1", routerFor });
    assert.equal(targetOf(afterSwitch.writes.rescheduled[0]?.job), "target-c", "the switched-off target is not picked by the fallback");
    assert.deepEqual(settledWith.at(-1), ["vendor-x"], "the router that settled the job was built with the families as they are at this poll");
  });

  test("a poll whose plan's families cannot be read leaves the row open, and builds no router for it", async () => {
    const { store, writes } = fakeStore([row()]);
    const unreadable: AssetPollStore = {
      ...store,
      async disabledFamiliesOf() {
        throw new Error("the workspace's policy is unreadable");
      },
    };
    let routers = 0;
    const report = await pollAssetJobs({
      store: unreadable,
      organizationId: "org_1",
      routerFor: () => {
        routers += 1;
        return fakeRouter({ poll: { state: "done", uri: "x" }, settle: DONE_WITH_BILL });
      },
    });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.equal(routers, 0, "no router is asked about the job while its families are unknown");
    assert.deepEqual(writes.rescheduled, [{ id: "row-1", job: JOB, runAfterMs: ASSET_POLL_AGAIN_MS }]);
    assert.equal(writes.finished.length, 0, "the row is not closed");
    assert.equal(writes.charged.length, 0, "its hold is not charged");
  });

  /** A failed poll that reports its bill, and the settle that says the job failed: what a queued job does when it bills and then fails. */
  const failedWithBill = (actualUsd: number | undefined) =>
    fakeRouter({
      poll: { state: "failed", error: { kind: "server", retryable: false, message: "the generation failed" }, actualUsd },
      settle: { status: "failed", providerId: "openrouter:video", error: { kind: "server", retryable: false, message: "the generation failed" } },
    });

  test("a queued job that bills 0.80 and then fails with a hold of 0.40 is recorded at 0.80: the bill above the hold is charged", async () => {
    const { store, writes } = fakeStore([row({ heldUsd: 0.4, holdUsd: 0.4 })]);
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(failedWithBill(0.8)) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.deepEqual(writes.charged, [{ id: "row-1", usd: 0.8 }], "the bill is above the hold, so it is charged, not the hold");
  });

  test("a failed job whose bill is below its hold, zero, or not reported is charged its hold", async () => {
    for (const actualUsd of [0.2, 0, undefined]) {
      const { store, writes } = fakeStore([row({ heldUsd: 0.4, holdUsd: 0.4 })]);
      await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(failedWithBill(actualUsd)) });
      assert.deepEqual(writes.charged, [{ id: "row-1", usd: 0.4 }], `a bill of ${String(actualUsd)} is charged the hold`);
    }
  });

  test("a retry the budget refuses on a line charges nothing for the refused call: the job that ran is charged its hold once, and no hold is added", async () => {
    const { store, writes } = fakeStore([row({ heldUsd: 0.4, holdUsd: 0.4 })]);
    const retryRefused = fakeRouter({
      poll: { state: "failed", error: { kind: "server", retryable: true, message: "503" } },
      settle: { status: "refused", reasons: ["openrouter:video: the workspace month has committed 5 USD, at or above its 5 USD budget, so no paid call starts"] },
    });
    const report = await pollAssetJobs({ store, organizationId: "org_1", routerFor: routerFor(retryRefused) });
    assert.deepEqual(report, { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.deepEqual(writes.charged, [{ id: "row-1", usd: 0.4 }], "the job that ran is charged its hold once");
    assert.equal(writes.rescheduled.length, 0, "the refused retry records no job, so it adds no hold");
    assert.equal(writes.overshoots.length, 0);
    assert.match(writes.finished[0]?.result ?? "", /the budget refused this video/);
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

  test("a finished row with no reported bill and no recorded hold stays waiting: nothing is stored, no event is written, and its run keeps refusing", async () => {
    const { org, plan } = await workspace("legacy-done");
    const key = await legacyRow(org, plan, "legacy-clip");
    const noBill = { status: "done", asset: { ...(DONE_WITH_BILL.asset as object), costUsd: null } };
    const report = await pollWith(org, fakeRouter({ poll: { state: "done", uri: "x" }, settle: noBill }));
    assert.deepEqual(report, { polled: 1, done: 0, failed: 0, waiting: 1 });
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key), undefined);
    assert.equal((await rowOf(org, key)).status, "waiting", "the unknown money is not closed as zero");
    assert.deepEqual(await listPlanEvents(db.sql, org, plan, 0), [], "no event is written");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0);
    assert.deepEqual((await waitingHoldsByNode(db.sql, org, plan)).unrecorded, ["legacy-clip"], "its run keeps refusing");
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
    await assert.rejects(sqlAssetPollStore(db.sql, mine.org).fail(foreign, "closed from the wrong workspace", 0.8), /not in this organization/);
    assert.equal((await rowOf(theirs.org, key)).status, "waiting", "the other workspace's row is unchanged");
    assert.equal(await failedHoldsUsd(db.sql, theirs.org, theirs.plan), 0);
  });

  test("REPRO 1 (store): a row closed as failed is not closed again by a completing settle: its hold counts once, and no bill is stored", async () => {
    const { org, plan } = await workspace("closed-twice");
    const key = await queued(org, plan, { seconds: 8, hold: 0.8 });
    const store = sqlAssetPollStore(db.sql, org);
    const [row] = await store.due(10);
    assert.ok(row, "the row is due");
    const failed = await store.fail(row, "the poll threw", 0.8);
    const lateCompleted = await store.complete(row, { outputHash: "h", costUsd: 0.4, body: "engine/x.mp4", category: "creative" }, "stored", { seconds: 8, actualUsd: 0.4 });
    const found = await rowOf(org, key);
    assert.equal(found.status, "failed", "the first close stands");
    assert.equal(found.result, "the poll threw", "the first close's reason stands");
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key), undefined, "no bill is stored for a row that failed");
    assert.deepEqual(await measurementsOf(org, plan, key), [], "nothing is measured");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0.8, "the hold counts once, as the failed hold");
    assert.equal(failed, true, "the first close wrote the row");
    assert.equal(lateCompleted, false, "the completing settle wrote nothing");
  });

  test("REPRO 2 (poll): a settle that finishes after its row was closed as failed changes nothing: the hold counts once, and the report counts no close", async () => {
    const { org, plan } = await workspace("settle-after-close");
    const key = await queued(org, plan, { seconds: 8, hold: 0.8 });
    const store = sqlAssetPollStore(db.sql, org);
    // Settler A claims the row. Its claim then lapses, as a claim does after two minutes, so another poll can take the row.
    const [claimedByA] = await store.due(10);
    assert.ok(claimedByA, "settler A claims the row");
    await db.sql`update orchestrator_asset_jobs set next_poll_at = now() - interval '1 minute' where organization_id = ${org}`;
    // Settler B's settle loses its claim to a retryable conflict, so the poll closes the row as failed and its hold is charged.
    const conflicted = {
      async pollOnce() {
        return { state: "done", uri: "x", actualUsd: 0.4 };
      },
      async settle() {
        throw new EngineError("conflict", `job ${JOB.idempotencyKey} is being settled by another run; it is retried`, { stage: "orchestrator_video", retryable: true });
      },
    } as unknown as AsyncAssetRouter;
    assert.deepEqual(await pollWith(org, conflicted), { polled: 1, done: 0, failed: 1, waiting: 0 });
    // Settler A finishes now with the bill. The row is no longer waiting, so nothing is stored and the report counts no close.
    const settlesLate: AssetPollStore = { ...store, async due() { return [claimedByA]; } };
    const lateReport = await pollAssetJobs({ store: settlesLate, organizationId: org, routerFor: routerFor(fakeRouter({ poll: { state: "done", uri: "x" }, settle: DONE_WITH_BILL })) });
    assert.equal((await rowOf(org, key)).status, "failed", "the failed close stands");
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key), undefined, "the late bill is not stored");
    assert.deepEqual(await measurementsOf(org, plan, key), [], "the late bill is not measured");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0.8, "the hold counts once");
    assert.deepEqual(lateReport, { polled: 1, done: 0, failed: 0, waiting: 0 }, "the report counts no close");
  });

  test("a row completed by one poll is not failed by another: its bill stands, and no failed event is written", async () => {
    const { org, plan } = await workspace("done-then-failed");
    const key = await queued(org, plan, { seconds: 8, hold: 0.8 });
    const store = sqlAssetPollStore(db.sql, org);
    const [row] = await store.due(10);
    assert.ok(row, "the row is due");
    const completed = await store.complete(row, { outputHash: "h", costUsd: 0.4, body: "engine/x.mp4", category: "creative" }, "stored", { seconds: 8, actualUsd: 0.4 });
    const lateFailed = await store.fail(row, "the poll threw", 0.8);
    assert.equal((await rowOf(org, key)).status, "done", "the first close stands");
    assert.equal((await listStepOutputs(db.sql, org, plan)).get(key)?.costUsd, 0.4, "the bill stands");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0, "no failed event is written for a row that was completed");
    assert.equal(completed, true, "the first close wrote the row");
    assert.equal(lateFailed, false, "the failing close wrote nothing");
  });

  test("REPRO 4 (budget) through the poll: a retry refused because its run's reservation was released closes the row as failed, charges its hold, and names the new run", async () => {
    const { org, plan } = await workspace("run-ended");
    const key = await queued(org, plan, { seconds: 8, hold: 0.8 });
    // The run's reservation is released when the run ends. A retry of the queued job is then refused by the budget (budget/reserve.ts).
    const ledger = memoryLedgerStore();
    const reservationId = newId("res_");
    await ledger.createReservation(
      budgetReservationSchema.parse({
        schema: BUDGET_RESERVATION_SCHEMA,
        reservationId,
        requestId: newId("req_"),
        workspaceId: org,
        mode: "cap",
        lines: [{ stage: "orchestrator_run", estimateUsd: 1 }],
        estimateUsd: 1,
        redoAllowanceUsd: 0,
        reservedUsd: 1,
        requestBudgetUsd: 5,
        workspaceMonthBudgetUsd: 100,
        state: "reserved",
        createdAt: "2026-10-23T10:00:00.000Z",
      }),
    );
    await releaseReservation(ledger, reservationId);
    const retry = await authorizeCall(ledger, { reservationId, stage: "orchestrator_video", provider: "openrouter", model: "vendor/video-model", estimateUsd: 0.8, idempotencyKey: "job-1|attempt2", at: "2026-10-23T10:20:00.000Z" });
    assert.equal(retry.status, "refused");
    // The router's answer to the poll: the refusal of the retry is among its reasons, and nothing is submitted.
    const answer = { status: "unavailable", reasons: ["openrouter:video: rate_limit: 429 Too Many Requests", `openrouter:video: ${retry.status === "refused" ? retry.reason : ""}`] };
    assert.deepEqual(await pollWith(org, fakeRouter({ poll: { state: "failed", error: { kind: "rate_limit", retryable: true, message: "429" } }, settle: answer })), { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal((await rowOf(org, key)).status, "failed");
    assert.equal((await rowOf(org, key)).result, RUN_ENDED_REASON);
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0.8, "the job's hold is charged once");
    const events = await listPlanEvents(db.sql, org, plan, 0);
    assert.deepEqual(events.map((e) => [e.nodeId, e.state, e.costUsd, e.reason]), [["clip", "failed", 0.8, RUN_ENDED_REASON]]);
  });

  test("the families a poll reads are the workspace's, with the plan's brand's, read from the database at each poll; a family switched off later is read at the next poll", async () => {
    const org = "org_poll_families";
    const brand = "brand_poll_families";
    await seedWorkspace(db.sql, org, brand);
    await writeOrchestratorPolicy(db.sql, { organizationId: org, actorId: "user_poll", patch: { disabledModelFamilies: ["vendor-w"] } });
    await writeBrandPolicy(db.sql, { organizationId: org, brandId: brand, actorId: "user_poll", disabledModelFamilies: ["vendor-b"] });
    await createPlanDraft(db.sql, { id: "plan_poll_brand", organizationId: org, title: "brand", brief: {}, orchestratorModel: "vendor-a/model-x", budgetUsd: 5, brandId: brand });
    await createPlanDraft(db.sql, { id: "plan_poll_nobrand", organizationId: org, title: "no brand", brief: {}, orchestratorModel: "vendor-a/model-x", budgetUsd: 5 });
    const store = sqlAssetPollStore(db.sql, org);
    assert.deepEqual([...(await store.disabledFamiliesOf("plan_poll_brand"))], ["vendor-b", "vendor-w"], "the workspace's families and the brand's");
    assert.deepEqual([...(await store.disabledFamiliesOf("plan_poll_nobrand"))], ["vendor-w"], "a plan with no brand has the workspace's alone");

    await writeOrchestratorPolicy(db.sql, { organizationId: org, actorId: "user_poll", patch: { disabledModelFamilies: ["vendor-w", "vendor-z"] } });
    assert.deepEqual([...(await store.disabledFamiliesOf("plan_poll_brand"))], ["vendor-b", "vendor-w", "vendor-z"], "a family switched off after the job was queued is read at the next poll");
    await assert.rejects(store.disabledFamiliesOf("plan_poll_not_here"), /not in this organization/, "a plan that is not the organization's has no families read for it");
  });

  test("a queued job that bills 0.80 and then fails with a hold of 0.40 is recorded at 0.80 on the plan, and the spend counts it", async () => {
    const { org, plan } = await workspace("bill-over-hold");
    const key = await queued(org, plan, { stepId: "clip", hold: 0.4 });
    const billedFailure = fakeRouter({
      poll: { state: "failed", error: { kind: "server", retryable: false, message: "the generation failed" }, actualUsd: 0.8 },
      settle: { status: "failed", providerId: "openrouter:video", error: { kind: "server", retryable: false, message: "the generation failed" } },
    });
    assert.deepEqual(await pollWith(org, billedFailure), { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal((await rowOf(org, key)).status, "failed");
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 0.8, "the bill is the failed charge, not the 0.40 hold");
    const events = await listPlanEvents(db.sql, org, plan, 0);
    assert.deepEqual(events.map((e) => [e.nodeId, e.state, e.costUsd]), [["clip", "failed", 0.8]]);
  });

  test("a retried job charges its first submit's bill above that submit's hold, and its last submit's bill over its hold", async () => {
    const { org, plan } = await workspace("retry-bills");
    const key = await queued(org, plan, { stepId: "clip", hold: 0.4 });
    // The first submit bills 0.80 and fails retryably: the retry takes its own hold (0.40) and the first submit's excess over its hold (0.40).
    const firstFailed = fakeRouter({
      poll: { state: "failed", error: { kind: "server", retryable: true, message: "503" }, actualUsd: 0.8 },
      settle: { status: "submitted", job: NEXT_JOB, runAfterMs: 15_000 },
    });
    await pollWith(org, firstFailed);
    assert.equal(Number((await rowOf(org, key)).held_usd ?? 0), 1.2, "the row holds both submits, and the first at its bill");

    await db.sql`update orchestrator_asset_jobs set next_poll_at = now() - interval '1 minute' where cache_key = ${key}`;
    // The last submit bills 0.30 and fails for good: it is charged its hold, the larger of hold and bill. Total: 0.80 + 0.40.
    const lastFailed = fakeRouter({
      poll: { state: "failed", error: { kind: "server", retryable: false, message: "the generation failed" }, actualUsd: 0.3 },
      settle: { status: "failed", providerId: "openrouter:video", error: { kind: "server", retryable: false, message: "the generation failed" } },
    });
    assert.deepEqual(await pollWith(org, lastFailed), { polled: 1, done: 0, failed: 1, waiting: 0 });
    assert.equal(await failedHoldsUsd(db.sql, org, plan), 1.2, "both submits are counted at what they cost, not at their holds");
  });
});
