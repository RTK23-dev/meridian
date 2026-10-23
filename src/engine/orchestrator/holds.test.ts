import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AssetJob } from "../assets/job.ts";
import type { ProduceInput } from "../assets/router.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { queueAssetJob } from "./asset-poll.ts";
import { jobStatusOf, measuredAverageUsdPerSecond, openQueuedJob, recordCostMeasurement, waitingHoldsByNode } from "./holds.ts";
import { createPlanDraft } from "./store.ts";

const INPUT = { spec: { shotId: "shot_0a", modelClass: "video.budget" }, requestId: "req_1", reservationId: "res_1" } as unknown as ProduceInput;
const JOB = { idempotencyKey: "job-1", jobRef: "provider-job-1" } as unknown as AssetJob;

describe("queued holds, measured costs and their organization scope (D14, D15, migration 0117)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
  });

  after(async () => {
    await db.close();
  });

  /** A workspace and one plan of it. */
  async function plan(org: string, id: string): Promise<string> {
    await seedWorkspace(db.sql, org);
    await createPlanDraft(db.sql, { id, organizationId: org, title: id, brief: {}, orchestratorModel: "orchestrator-test-model", budgetUsd: 5 });
    return id;
  }

  /** A job the run queued (queueAssetJob), with its hold recorded. It waits until the poll settles it. */
  async function queue(org: string, planId: string, stepId: string, cacheKey: string, hold: number, seconds: number | null = 8): Promise<void> {
    await queueAssetJob(db.sql, org, { planId, stepId, cacheKey, kind: "video", input: INPUT, job: JOB, runAfterMs: 60_000, hold, seconds });
  }

  /** A job queued before migration 0117: its hold and its length were never recorded. */
  async function queueUnrecorded(org: string, planId: string, stepId: string, cacheKey: string): Promise<void> {
    await db.sql`
      insert into orchestrator_asset_jobs (id, organization_id, plan_id, request_id, reservation_id, step_id, cache_key, kind, input, job)
      values (${globalThis.crypto.randomUUID()}, ${org}, ${planId}, 'req_1', 'res_1', ${stepId}, ${cacheKey}, 'video',
        ${JSON.stringify(INPUT)}::jsonb, ${JSON.stringify(JOB)}::jsonb)
    `;
  }

  test("the holds of waiting jobs are summed by step, and a waiting job with no recorded hold is listed, never counted as zero", async () => {
    const org = "org_holds_sum";
    const planId = await plan(org, "plan_holds_sum");
    await queue(org, planId, "video-a", "key-sum-1", 1.25);
    await queue(org, planId, "video-a", "key-sum-2", 0.75);
    await queue(org, planId, "avatar-b", "key-sum-3", 2);
    await queueUnrecorded(org, planId, "legacy-c", "key-sum-4");

    const holds = await waitingHoldsByNode(db.sql, org, planId);
    assert.deepEqual(Object.fromEntries(holds.byNode), { "video-a": 2, "avatar-b": 2 }, "two jobs of one step add up; the unrecorded one adds nothing");
    assert.deepEqual(holds.unrecorded, ["legacy-c"]);
    assert.equal(holds.byNode.has("legacy-c"), false, "an unknown hold is never counted as zero");
  });

  test("a job that has settled holds nothing: only waiting jobs count", async () => {
    const org = "org_holds_settled";
    const planId = await plan(org, "plan_holds_settled");
    await queue(org, planId, "avatar-b", "key-settled-1", 2);
    await queue(org, planId, "video-a", "key-settled-2", 1);
    await db.sql`update orchestrator_asset_jobs set status = 'done' where organization_id = ${org} and cache_key = 'key-settled-1'`;
    await db.sql`update orchestrator_asset_jobs set status = 'failed' where organization_id = ${org} and cache_key = 'key-settled-2'`;

    const holds = await waitingHoldsByNode(db.sql, org, planId);
    assert.equal(holds.byNode.size, 0, "a done job is in its stored output, and a failed one is a failed hold: neither waits");
    assert.deepEqual(holds.unrecorded, []);
  });

  test("a job is open only while it waits, and only for its own cache key", async () => {
    const org = "org_holds_open";
    const planId = await plan(org, "plan_holds_open");
    await queue(org, planId, "video-a", "key-open-1", 0.5);
    assert.equal(await openQueuedJob(db.sql, org, planId, "key-open-1"), true);
    assert.equal(await openQueuedJob(db.sql, org, planId, "key-open-missing"), false, "another step's key is not open");
    await db.sql`update orchestrator_asset_jobs set status = 'done' where organization_id = ${org} and cache_key = 'key-open-1'`;
    assert.equal(await openQueuedJob(db.sql, org, planId, "key-open-1"), false, "a settled job is no longer open");
  });

  test("a job's status for its cache key is waiting, failed, done, or none; another plan or organization reads as none (D14)", async () => {
    const org = "org_holds_status";
    const planId = await plan(org, "plan_holds_status");
    const otherPlan = await plan(org, "plan_holds_status_other");
    assert.equal(await jobStatusOf(db.sql, org, planId, "key-status-none"), "none", "the plan has no job for the key");

    await queue(org, planId, "video-a", "key-status-waiting", 0.5);
    await queue(org, planId, "video-a", "key-status-failed", 0.5);
    await queue(org, planId, "video-a", "key-status-done", 0.5);
    await db.sql`update orchestrator_asset_jobs set status = 'failed' where organization_id = ${org} and cache_key = 'key-status-failed'`;
    await db.sql`update orchestrator_asset_jobs set status = 'done' where organization_id = ${org} and cache_key = 'key-status-done'`;
    assert.equal(await jobStatusOf(db.sql, org, planId, "key-status-waiting"), "waiting");
    assert.equal(await jobStatusOf(db.sql, org, planId, "key-status-failed"), "failed");
    assert.equal(await jobStatusOf(db.sql, org, planId, "key-status-done"), "done");
    assert.equal(await jobStatusOf(db.sql, org, otherPlan, "key-status-failed"), "none", "another plan's job is not this plan's");

    await seedWorkspace(db.sql, "org_holds_status_theirs");
    assert.equal(await jobStatusOf(db.sql, "org_holds_status_theirs", planId, "key-status-failed"), "none", "another organization reads as none");

    await queue(org, planId, "video-a", "key-status-failed", 0.5);
    assert.equal(await jobStatusOf(db.sql, org, planId, "key-status-failed"), "waiting", "a key with a waiting job reports waiting first");
  });

  test("the measured average is null until a clip is measured, then the reported cost per second; a waiting job adds nothing", async () => {
    const org = "org_holds_avg";
    const planId = await plan(org, "plan_holds_avg");
    assert.equal(await measuredAverageUsdPerSecond(db.sql, org), null, "no measurement, no average");

    await queue(org, planId, "video-a", "key-avg-waiting", 5, 8);
    assert.equal(await measuredAverageUsdPerSecond(db.sql, org), null, "a hold is an estimate, so it is not measured");

    await recordCostMeasurement(db.sql, org, { planId, cacheKey: "key-avg-1", kind: "video", seconds: 8, actualUsd: 2 });
    await recordCostMeasurement(db.sql, org, { planId, cacheKey: "key-avg-2", kind: "avatar", seconds: 4, actualUsd: 1 });
    assert.deepEqual(await measuredAverageUsdPerSecond(db.sql, org), { usdPerSecond: 0.25, seconds: 12, clips: 2 }, "3 dollars over 12 seconds");
  });

  test("a measurement is recorded once per plan and cache key, and only for a plan of the organization", async () => {
    const org = "org_holds_once";
    const planId = await plan(org, "plan_holds_once");
    const measurement = { planId, cacheKey: "key-once", kind: "video" as const, seconds: 6, actualUsd: 1.5 };
    assert.equal(await recordCostMeasurement(db.sql, org, measurement), true);
    assert.equal(await recordCostMeasurement(db.sql, org, { ...measurement, actualUsd: 9 }), false, "the first measurement stands");
    const [count] = await db.sql<{ n: unknown; usd: unknown }>`
      select count(*) as n, sum(actual_usd) as usd from orchestrator_cost_measurements where organization_id = ${org} and plan_id = ${planId}
    `;
    assert.equal(Number(count?.n), 1);
    assert.equal(Number(count?.usd), 1.5);

    const other = "org_holds_once_other";
    await seedWorkspace(db.sql, other);
    assert.equal(await recordCostMeasurement(db.sql, other, { ...measurement, cacheKey: "key-once-other" }), false, "a plan of another workspace is refused");
    const [written] = await db.sql<{ n: unknown }>`select count(*) as n from orchestrator_cost_measurements where organization_id = ${other}`;
    assert.equal(Number(written?.n), 0, "nothing is written for the other workspace");
  });

  test("another organization sees none of these holds, open jobs or measurements", async () => {
    const mine = "org_holds_sum";
    const minePlan = "plan_holds_sum";
    const theirs = "org_holds_theirs";
    await seedWorkspace(db.sql, theirs);

    const holds = await waitingHoldsByNode(db.sql, theirs, minePlan);
    assert.equal(holds.byNode.size, 0, "another workspace's waiting holds are not read");
    assert.deepEqual(holds.unrecorded, []);
    assert.equal(await openQueuedJob(db.sql, theirs, minePlan, "key-sum-1"), false, "another workspace's job is not open here");
    assert.equal(await measuredAverageUsdPerSecond(db.sql, theirs), null, "another workspace's measurements are not averaged here");
    assert.ok((await measuredAverageUsdPerSecond(db.sql, "org_holds_avg")) !== null, "the owner's measurements are there");
    assert.equal((await waitingHoldsByNode(db.sql, mine, minePlan)).byNode.get("video-a"), 2, "the owner still sees its own holds");
  });
});
