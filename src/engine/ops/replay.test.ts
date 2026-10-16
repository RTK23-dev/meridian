// Dead-letter listing and replay on PGlite (Video Engine Bible 5.2, 15.5, 19 E6). A deliver job fails on every attempt; the worker's
// own claim and retry code runs it three times, the last one records the dead letter, and the request pauses with its artifacts. The
// replay then re-queues the stage once. Nothing here calls a live API (chain.ts documents the recorded providers).

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { listDeadJobs } from "./deadletter.ts";
import { REPLAY_MINIMUM_ROLE, replayDeadJob, type ReplayOutcome } from "./replay.ts";
import { chainWorld, drain, setDeliverFault, startChainRequest } from "./test/chain.ts";
import { withRenderBills } from "../jobs/test/harness.ts";

const WS = "ws_ops_replay";
const BRAND = "brand_ops_replay";
const FORMAT = "fmt_ops_replay";
const ADMIN = { userId: "user_ops_admin", role: "admin" };
const MEMBER = { userId: "user_ops_member", role: "member" };

const databases: TestDatabase[] = [];
after(async () => {
  for (const db of databases) await db.close();
});

function refusalOf(outcome: ReplayOutcome): string | null {
  return outcome.status === "refused" ? outcome.reason : null;
}

async function countOf(db: TestDatabase, query: "audits" | "deliveries" | "deliver_jobs"): Promise<number> {
  const rows =
    query === "audits"
      ? await db.sql<{ n: number }>`select count(*)::int as n from engine_events where organization_id = ${WS} and kind = 'ops.replay'`
      : query === "deliveries"
        ? await db.sql<{ n: number }>`select count(*)::int as n from engine_events where organization_id = ${WS} and kind = 'video.delivered'`
        : await db.sql<{ n: number }>`select count(*)::int as n from jobs where organization_id = ${WS} and job_type = 'engine.deliver'`;
  return rows[0]?.n ?? -1;
}

describe("dead letters and replay (Video Engine Bible 5.2, 15.5)", () => {
  test("a dead stage pauses its request and is listed; a member cannot replay; an admin replay re-queues the stage once", async () => {
    const db = await createTestDatabase();
    databases.push(db);
    await seedWorkspace(db.sql, WS, BRAND);
    const world = await chainWorld(db.sql, WS);
    // The renders are billed before each deliver attempt, as the owner's invoices are recorded (contract v6); see withRenderBills.
    const runtime = withRenderBills(db.sql, world.runtime);
    const request = await startChainRequest(world, { slot: 1, brandId: BRAND, formatId: FORMAT, priority: "normal", variantCount: 0 });

    setDeliverFault(world, request.requestId, true);
    const first = await drain(db.sql, runtime, WS);
    assert.equal(first.dead, 1, "the deliver job is dead after its last attempt");
    assert.equal(first.retried, 2, "it was retried twice before that: three attempts in all");

    const paused = await readEngineRequest(db.sql, WS, request.requestId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.state.pause?.kind, "dead_letter");
    assert.equal(paused?.state.pause?.stage, "deliver");

    const dead = await listDeadJobs(db.sql, { organizationId: WS, requestId: request.requestId });
    assert.equal(dead.length, 1, "the request lists its one dead job");
    const job = dead[0];
    assert.ok(job);
    assert.equal(job.stage, "deliver");
    assert.equal(job.attempts, 3);
    assert.equal(job.maxAttempts, 3);
    assert.equal(job.recorded, true, "the dead event is on the request");
    assert.equal(job.replayed, false);
    assert.equal(job.pausedHere, true);
    assert.match(job.lastError, /injected fault/);

    const memberTry = await replayDeadJob(db.sql, { organizationId: WS, requestId: request.requestId, jobId: job.jobId, actor: MEMBER });
    assert.equal(refusalOf(memberTry), "not_authorized", `replay needs the ${REPLAY_MINIMUM_ROLE} role`);
    assert.equal(REPLAY_MINIMUM_ROLE, "admin");

    setDeliverFault(world, request.requestId, false);
    const replayed = await replayDeadJob(db.sql, { organizationId: WS, requestId: request.requestId, jobId: job.jobId, actor: ADMIN });
    assert.equal(replayed.status, "replayed");
    if (replayed.status === "replayed") {
      assert.equal(replayed.stage, "deliver");
      assert.equal(replayed.requestStatus, "running");
      assert.ok(replayed.queued >= 1, "the stage is queued again");
    }

    const again = await replayDeadJob(db.sql, { organizationId: WS, requestId: request.requestId, jobId: job.jobId, actor: ADMIN });
    assert.equal(again.status, "duplicate", "a second replay of the same dead job changes nothing");
    assert.equal(await countOf(db, "audits"), 1, "one audit row for the replayed job; the refused member call wrote none");

    const second = await drain(db.sql, runtime, WS);
    assert.equal(second.dead, 0);
    assert.equal((await readEngineRequest(db.sql, WS, request.requestId))?.status, "delivered");
    assert.equal(await countOf(db, "deliver_jobs"), 2, "the replay queued a new attempt; the dead one stays on record");
    assert.equal(await countOf(db, "deliveries"), 1, "the master is delivered once");

    const listed = await listDeadJobs(db.sql, { organizationId: WS, requestId: request.requestId });
    assert.equal(listed[0]?.replayed, true);
    assert.equal(listed[0]?.pausedHere, false, "the request is no longer paused on it");
  });

  test("a replay is refused for a job that is not dead, for an unknown workspace, and without a user", async () => {
    const db = await createTestDatabase();
    databases.push(db);
    await seedWorkspace(db.sql, WS, BRAND);
    const world = await chainWorld(db.sql, WS);
    const runtime = withRenderBills(db.sql, world.runtime);
    const request = await startChainRequest(world, { slot: 2, brandId: BRAND, formatId: FORMAT, priority: "normal", variantCount: 0 });
    await drain(db.sql, runtime, WS);
    assert.equal((await readEngineRequest(db.sql, WS, request.requestId))?.status, "delivered");

    const succeeded = await db.sql<{ id: string }>`
      select id from jobs where organization_id = ${WS} and job_type = 'engine.compose' and status = 'succeeded' limit 1
    `;
    const jobId = succeeded[0]?.id;
    assert.ok(jobId, "a compose job succeeded");

    const notDead = await replayDeadJob(db.sql, { organizationId: WS, requestId: request.requestId, jobId, actor: ADMIN });
    assert.equal(refusalOf(notDead), "not_dead");

    const otherWorkspace = await replayDeadJob(db.sql, { organizationId: "ws_ops_other", requestId: request.requestId, jobId, actor: ADMIN });
    assert.equal(refusalOf(otherWorkspace), "not_found", "a job is found only in its own workspace");

    const nobody = await replayDeadJob(db.sql, { organizationId: WS, requestId: request.requestId, jobId, actor: { userId: " ", role: "admin" } });
    assert.equal(refusalOf(nobody), "not_authorized");

    assert.deepEqual(await listDeadJobs(db.sql, { organizationId: WS, requestId: request.requestId }), [], "a request with no dead job lists none");
  });
});
