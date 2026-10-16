// The video engine operations surface on PGlite (Video Engine Bible 15.3, 5.2, 19 E6): the stage metrics, the dead jobs of a request and
// the replay. Each refusal is checked where it happens: a stranger, a member of another workspace, a member without the admin role, and
// a caller who names another workspace in the body. The request runs through the engine's own stages with recorded providers
// (src/engine/ops/test/chain.ts); nothing here calls a live API.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { chainWorld, drain, setDeliverFault, startChainRequest, type ChainWorld } from "../../../engine/ops/test/chain.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import { deadJobsInput, METRICS_DEFAULT_WINDOW_MS, replayInput, stageMetricsInput } from "./input.ts";
import { readRequestDeadJobs, readWorkspaceStageMetrics, replayRequestDeadJob, REQUEST_REFUSAL, WORKSPACE_REFUSAL } from "./service.ts";

const WS = "ws_eops_a";
const OTHER_WS = "ws_eops_b";
const BRAND = "brand_eops_a";
const FORMAT = "fmt_eops_a";
const ADMIN = "user_eops_admin";
const MEMBER = "user_eops_member";
const VIEWER = "user_eops_viewer";
const OTHER_ADMIN = "user_eops_other_admin";
const STRANGER = "user_eops_stranger";

async function seedUser(sql: Sql, userId: string, organizationId: string | null, role: string | null): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  if (organizationId !== null && role !== null) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, ${role})`;
  }
}

describe("video engine operations: input checks", () => {
  test("the stage metrics window defaults to the last seven days, and a start time is kept as ISO text", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const defaulted = stageMetricsInput({ organizationId: WS }, now);
    assert.equal(defaulted.organizationId, WS);
    assert.equal(defaulted.since, new Date(now.getTime() - METRICS_DEFAULT_WINDOW_MS).toISOString());
    assert.equal(stageMetricsInput({ organizationId: WS, since: "2026-10-01" }, now).since, "2026-10-01T00:00:00.000Z");
  });

  test("a blank or long workspace id and a bad start time are refused", () => {
    assert.throws(() => stageMetricsInput({ organizationId: "  " }), /Choose a workspace/);
    assert.throws(() => stageMetricsInput({ organizationId: "x".repeat(101) }), /Choose a workspace/);
    assert.throws(() => stageMetricsInput({ organizationId: WS, since: "not a time" }), /valid start time/);
    assert.throws(() => stageMetricsInput(null), /Choose a workspace/);
  });

  test("the dead-job limit is a whole number from 1 to 1000, and the default is 200", () => {
    assert.deepEqual(deadJobsInput({ requestId: "req_1" }), { requestId: "req_1", limit: 200 });
    assert.equal(deadJobsInput({ requestId: "req_1", limit: 1000 }).limit, 1000);
    for (const limit of [0, 1001, 2.5, "10"]) {
      assert.throws(() => deadJobsInput({ requestId: "req_1", limit }), /limit from 1 to 1000/);
    }
  });

  test("a replay names one request and one job; other fields, the workspace included, are dropped", () => {
    assert.deepEqual(replayInput({ requestId: "req_1", jobId: "job_1", organizationId: OTHER_WS, role: "admin" }), {
      requestId: "req_1",
      jobId: "job_1",
    });
    assert.throws(() => replayInput({ requestId: "req:1", jobId: "job_1" }), /valid request/);
    assert.throws(() => replayInput({ requestId: "req_1", jobId: "" }), /valid job/);
  });
});

describe("video engine operations: reads and replay", () => {
  let db: TestDatabase;
  let world: ChainWorld;
  let requestId: string;
  let deadJobId: string;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await seedWorkspace(db.sql, OTHER_WS);
    await seedUser(db.sql, ADMIN, WS, "admin");
    await seedUser(db.sql, MEMBER, WS, "member");
    await seedUser(db.sql, VIEWER, WS, "viewer");
    await seedUser(db.sql, OTHER_ADMIN, OTHER_WS, "admin");
    await seedUser(db.sql, STRANGER, null, null);

    world = await chainWorld(db.sql, WS);
    const request = await startChainRequest(world, { slot: 1, brandId: BRAND, formatId: FORMAT, priority: "normal", variantCount: 0 });
    requestId = request.requestId;
    setDeliverFault(world, requestId, true);
    const drained = await drain(db.sql, world.runtime, WS);
    assert.equal(drained.dead, 1, "the deliver job is dead after its last attempt");

    const dead = await readRequestDeadJobs(db.sql, ADMIN, deadJobsInput({ requestId }));
    assert.equal(dead.length, 1);
    const job = dead[0];
    assert.ok(job);
    deadJobId = job.jobId;
  });

  after(async () => {
    await db.close();
  });

  async function replayAuditRows(): Promise<number> {
    const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_events where organization_id = ${WS} and kind = 'ops.replay'`;
    return rows[0]?.n ?? -1;
  }

  async function deadJobStatus(): Promise<string | undefined> {
    const rows = await db.sql<{ status: string }>`select status from jobs where id = ${deadJobId} and organization_id = ${WS}`;
    return rows[0]?.status;
  }

  test("any member of the workspace reads its stage metrics, including a viewer", async () => {
    const since = stageMetricsInput({ organizationId: WS }).since;
    for (const userId of [ADMIN, MEMBER, VIEWER]) {
      const report = await readWorkspaceStageMetrics(db.sql, userId, { organizationId: WS, since });
      assert.equal(report.workspaces, 1);
      assert.equal(report.requests.total, 1);
      assert.equal(report.requests.paused, 1, "the request is paused on its dead letter");
      assert.equal(report.requests.delivered, 0);
      assert.ok(report.stages.length > 0, "the stages that ran have durations");
    }
  });

  test("the stage metrics refuse a stranger and a member of another workspace; the other workspace reads only its own data", async () => {
    const since = stageMetricsInput({ organizationId: WS }).since;
    await assert.rejects(readWorkspaceStageMetrics(db.sql, STRANGER, { organizationId: WS, since }), { message: WORKSPACE_REFUSAL });
    await assert.rejects(readWorkspaceStageMetrics(db.sql, OTHER_ADMIN, { organizationId: WS, since }), { message: WORKSPACE_REFUSAL });

    const own = await readWorkspaceStageMetrics(db.sql, OTHER_ADMIN, { organizationId: OTHER_WS, since });
    assert.equal(own.requests.total, 0, "the other workspace has no requests, so none of this workspace's are counted");
  });

  test("the dead jobs of a request are listed for any member of its workspace", async () => {
    for (const userId of [ADMIN, MEMBER, VIEWER]) {
      const jobs = await readRequestDeadJobs(db.sql, userId, deadJobsInput({ requestId }));
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.ok(job);
      assert.equal(job.jobId, deadJobId);
      assert.equal(job.stage, "deliver");
      assert.equal(job.recorded, true, "the dead event is on the request");
      assert.equal(job.pausedHere, true);
      assert.match(job.lastError, /injected fault/);
    }
  });

  test("the dead jobs are refused to a stranger and to a member of another workspace, and an unknown request gets the same refusal", async () => {
    for (const userId of [STRANGER, OTHER_ADMIN]) {
      await assert.rejects(readRequestDeadJobs(db.sql, userId, deadJobsInput({ requestId })), { message: REQUEST_REFUSAL });
    }
    await assert.rejects(readRequestDeadJobs(db.sql, ADMIN, deadJobsInput({ requestId: "req_eops_missing" })), { message: REQUEST_REFUSAL });
  });

  test("a member and a viewer cannot replay; the refusal writes nothing and the job stays dead", async () => {
    for (const userId of [MEMBER, VIEWER]) {
      await assert.rejects(replayRequestDeadJob(db.sql, userId, replayInput({ requestId, jobId: deadJobId })), {
        message: /needs the admin role/,
      });
    }
    assert.equal(await replayAuditRows(), 0, "no audit row for a refused replay");
    assert.equal(await deadJobStatus(), "dead");
    assert.equal((await readEngineRequest(db.sql, WS, requestId))?.status, "paused");
  });

  test("an admin of another workspace cannot replay this request, even by naming their own workspace in the body", async () => {
    const spoofed = replayInput({ requestId, jobId: deadJobId, organizationId: OTHER_WS });
    await assert.rejects(replayRequestDeadJob(db.sql, OTHER_ADMIN, spoofed), { message: REQUEST_REFUSAL });
    await assert.rejects(replayRequestDeadJob(db.sql, STRANGER, replayInput({ requestId, jobId: deadJobId })), { message: REQUEST_REFUSAL });
    assert.equal(await replayAuditRows(), 0);
    assert.equal(await deadJobStatus(), "dead");
  });

  test("an admin replays the dead job once, a second replay is a duplicate, and the request then delivers", async () => {
    setDeliverFault(world, requestId, false);
    const replayed = await replayRequestDeadJob(db.sql, ADMIN, replayInput({ requestId, jobId: deadJobId }));
    assert.equal(replayed.status, "replayed");
    if (replayed.status === "replayed") {
      assert.equal(replayed.stage, "deliver");
      assert.equal(replayed.requestStatus, "running");
      assert.ok(replayed.queued >= 1, "the stage is queued again");
    }

    const again = await replayRequestDeadJob(db.sql, ADMIN, replayInput({ requestId, jobId: deadJobId }));
    assert.equal(again.status, "duplicate");
    assert.equal(await replayAuditRows(), 1, "one audit row for the replayed job");

    const audit = await db.sql<{ body: string }>`select body from engine_events where organization_id = ${WS} and kind = 'ops.replay'`;
    const body = JSON.parse(audit[0]?.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.actorUserId, ADMIN, "the audit names the caller");
    assert.equal(body.actorRole, "admin", "the role is the one the database holds");

    const drained = await drain(db.sql, world.runtime, WS);
    assert.equal(drained.dead, 0);
    assert.equal((await readEngineRequest(db.sql, WS, requestId))?.status, "delivered");

    const listed = await readRequestDeadJobs(db.sql, MEMBER, deadJobsInput({ requestId }));
    assert.equal(listed[0]?.replayed, true);
    assert.equal(listed[0]?.pausedHere, false, "the request is no longer paused on it");
  });
});
