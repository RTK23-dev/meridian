// The E6 load test (Video Engine Bible 19 E6): 100 requests across 10 formats and 3 brand pages, run together on PGlite with recorded
// providers (chain.ts). Every request is started and its upstream stages answered; then the queue drains with all of them in flight.
// Four requests fail their deliver stage on every attempt and pause on a dead letter. The operator replays three of them once the fault
// is gone; the fourth stays paused, so the test shows a request failing closed and staying on record. Nothing is lost, and the operations
// reads (metrics, alerts, dead letters, batch planning, concurrency proposals) are checked on the same database.
//
// The timings and costs this test measures are for the Bible's E6 write-back (ops/STATUS.md): they are printed as diagnostics. The test
// does not assert a time or a cost budget; the owner's live run measures those on real providers.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { RequestPriority } from "../jobs/settings.ts";
import { evaluateAlerts } from "./alerts.ts";
import { readAlertSnapshot } from "./alerts-sql.ts";
import { planBatch, summarizeBatch, type BatchPlan } from "./batch.ts";
import { BUCKET_CLASSES, proposeConcurrency } from "./concurrency.ts";
import { listDeadJobs } from "./deadletter.ts";
import { replayDeadJob } from "./replay.ts";
import { readStageMetrics } from "./metrics-sql.ts";
import { proposedOpsThresholds } from "./thresholds.ts";
import { chainWorld, drain, musicVariantRequest, setDeliverFault, startChainRequest, type ChainRequest } from "./test/chain.ts";

const WS = "ws_ops_load";
const BRANDS = ["brand_load_a", "brand_load_b", "brand_load_c"];
const FORMATS = Array.from({ length: 10 }, (_, index) => `fmt_load_${String(index + 1).padStart(2, "0")}`);
const REQUESTS = 100;
/** Every 25th request from slot 13 fails its deliver stage: slots 13, 38, 63 and 88. */
const FAULTED = new Set([13, 38, 63, 88]);
/** The operator replays these three once the fault is gone. Slot 88 is not replayed and stays paused (fail closed). */
const REPLAYED = [13, 38, 63];
/** Every fifth request asks for one music variant: 20 requests, 20 variants. */
const VARIANT_EVERY = 5;
/** Every tenth request is a batch request, which the route cannot batch: 10 requests. */
const BATCH_EVERY = 10;
const ADMIN = { userId: "user_ops_admin", role: "admin" };
const MINUTE_MS = 60_000;

const databases: TestDatabase[] = [];
after(async () => {
  for (const db of databases) await db.close();
});

async function statusCount(db: TestDatabase, status: string): Promise<number> {
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_requests where organization_id = ${WS} and status = ${status}`;
  return rows[0]?.n ?? -1;
}

async function liveEngineJobs(db: TestDatabase): Promise<number> {
  const rows = await db.sql<{ n: number }>`
    select count(*)::int as n from jobs where organization_id = ${WS} and job_type like 'engine.%' and status in ('queued', 'running', 'retry')
  `;
  return rows[0]?.n ?? -1;
}

describe("E6 batch scale: 100 requests across 10 formats and 3 brand pages", () => {
  test("every request completes or fails closed, none is lost, and the operations reads report the run", { timeout: 900_000 }, async (t) => {
    const db = await createTestDatabase();
    databases.push(db);
    await seedWorkspace(db.sql, WS);
    for (const brand of BRANDS) {
      await db.sql`insert into brands (id, organization_id, name, created_by) values (${brand}, ${WS}, ${brand}, 'test') on conflict (id) do nothing`;
    }
    const world = await chainWorld(db.sql, WS);

    // Phase 1: every request is started and its upstream stages are answered, so each one is queued at compose.
    const started: Array<{ slot: number; priority: RequestPriority; variant: boolean; request: ChainRequest }> = [];
    for (let slot = 1; slot <= REQUESTS; slot += 1) {
      const variant = slot % VARIANT_EVERY === 0;
      const priority: RequestPriority = slot % BATCH_EVERY === 0 ? "batch" : "normal";
      const request = await startChainRequest(world, {
        slot,
        brandId: BRANDS[(slot - 1) % BRANDS.length],
        formatId: FORMATS[(slot - 1) % FORMATS.length],
        priority,
        variantCount: variant ? 1 : 0,
        ...(variant ? { request: musicVariantRequest() } : {}),
      });
      started.push({ slot, priority, variant, request });
      if (FAULTED.has(slot)) setDeliverFault(world, request.requestId, true);
    }
    assert.equal(new Set(started.map((item) => item.request.requestId)).size, REQUESTS, "every request has its own id");
    assert.equal(await statusCount(db, "running"), REQUESTS, "every request is running after its upstream stages");

    // Phase 2: the queue drains with every request in flight together.
    const firstDrain = await drain(db.sql, world.runtime, WS, { maxPasses: 500 });
    t.diagnostic(`first drain: ${JSON.stringify(firstDrain)}`);
    assert.equal(await statusCount(db, "delivered"), REQUESTS - FAULTED.size, "the requests with no fault are delivered");
    assert.equal(await statusCount(db, "paused"), FAULTED.size, "the faulted requests pause on their dead letters");

    // Phase 3: the operator clears the fault and replays three dead jobs, once each. A second replay of one of them changes nothing.
    const replayed: Array<{ requestId: string; jobId: string }> = [];
    for (const slot of REPLAYED) {
      const entry = started.find((item) => item.slot === slot);
      assert.ok(entry, `slot ${slot} was started`);
      const requestId = entry.request.requestId;
      setDeliverFault(world, requestId, false);
      const dead = await listDeadJobs(db.sql, { organizationId: WS, requestId });
      const job = dead.find((item) => item.pausedHere);
      assert.ok(job, `slot ${slot} lists its paused dead job`);
      const outcome = await replayDeadJob(db.sql, { organizationId: WS, requestId, jobId: job.jobId, actor: ADMIN });
      assert.equal(outcome.status, "replayed", `slot ${slot} replays`);
      replayed.push({ requestId, jobId: job.jobId });
    }
    const firstReplay = replayed[0];
    assert.ok(firstReplay);
    const again = await replayDeadJob(db.sql, { organizationId: WS, requestId: firstReplay.requestId, jobId: firstReplay.jobId, actor: ADMIN });
    assert.equal(again.status, "duplicate", "a second replay of the same dead job is a duplicate");

    const secondDrain = await drain(db.sql, world.runtime, WS, { maxPasses: 500 });
    t.diagnostic(`second drain: ${JSON.stringify(secondDrain)}`);

    // Nothing is lost: each request is delivered, or paused on a recorded dead letter, and no engine job is left in flight.
    assert.equal(await statusCount(db, "delivered"), REQUESTS - 1, "all but the unreplayed request are delivered");
    assert.equal(await statusCount(db, "paused"), 1, "the unreplayed request stays paused");
    assert.equal(await statusCount(db, "running"), 0, "no request is still running");
    assert.equal(await statusCount(db, "rejected"), 0, "no request is rejected");
    assert.equal(await liveEngineJobs(db), 0, "no engine job is left queued, running or retrying");
    const paused = started.find((item) => item.slot === 88);
    assert.ok(paused);
    const pausedDead = await listDeadJobs(db.sql, { organizationId: WS, requestId: paused.request.requestId });
    assert.equal(pausedDead.length, 1, "the paused request lists its dead job");
    assert.equal(pausedDead[0]?.pausedHere, true);

    // Metrics: p95 time and cost per master and per variant (Bible 15.3, E6).
    const metrics = await readStageMetrics(db.sql, { organizationIds: [WS] }, { now: () => new Date() });
    t.diagnostic(
      `metrics: ${JSON.stringify({
        requests: metrics.requests,
        masters: metrics.cost.masters,
        variants: metrics.cost.variants,
        unknownMasters: metrics.cost.unknownMasters,
        reconciled: [metrics.cost.reconciledRequests, metrics.cost.mismatchedRequests, metrics.cost.unreconciledRequests],
        stages: metrics.stages.map((stage) => ({ stage: stage.stage, basis: stage.basis, count: stage.count, p50Ms: stage.p50Ms, p95Ms: stage.p95Ms })),
        queue: metrics.queue,
      })}`,
    );
    assert.equal(metrics.requests.total, REQUESTS);
    assert.equal(metrics.requests.delivered, REQUESTS - 1);
    assert.equal(metrics.requests.paused, 1);
    assert.equal(metrics.requests.running, 0);
    assert.equal(metrics.requests.rejected, 0);
    assert.equal(metrics.requests.wallMs.count, REQUESTS - 1, "every delivered request has a wall time");
    assert.notEqual(metrics.requests.wallMs.p95, null, "the p95 request time is measured");
    assert.equal(metrics.requests.unknownWall, 0);
    assert.equal(metrics.cost.masters.count, REQUESTS - 1, "one master per delivered request");
    assert.notEqual(metrics.cost.masters.p95Usd, null, "the p95 cost per master is measured");
    assert.equal(metrics.cost.unknownMasters, 0);
    assert.equal(metrics.cost.variants.count, REQUESTS / VARIANT_EVERY, "one variant per variant request");
    assert.equal(metrics.cost.reconciledRequests, REQUESTS - 1, "each delivered request's ledger matches its videos");
    assert.equal(metrics.cost.mismatchedRequests, 0);
    assert.equal(metrics.cost.unreconciledRequests, 1, "the paused request has ledger rows and no delivered video");
    assert.equal(metrics.negativeStageSamples, 0);
    assert.ok(metrics.stages.some((stage) => stage.stage === "deliver" && stage.count >= REQUESTS - 1), "the deliver stage is timed");
    // The one failing check on purpose is shot 3's first take (chain.ts), so the take gate is the only gate below a pass rate of one.
    assert.ok(metrics.gates.byGate.length > 0, "gate results are read");
    assert.deepEqual(
      metrics.gates.byGate.filter((gate) => gate.passRate !== 1).map((gate) => gate.gate),
      ["take"],
      "only the take gate has a failing evaluation",
    );
    assert.deepEqual(metrics.providers, [], "the chain makes no provider call through the router, so no provider rate is measured");
    assert.equal(
      metrics.queue.reduce((sum, item) => sum + item.dead, 0),
      FAULTED.size,
      "each faulted deliver job is dead on record",
    );

    // Alerts: an hour after the run, the one open dead letter is over its limit; nothing else holds.
    const alerts = evaluateAlerts(await readAlertSnapshot(db.sql, { organizationIds: [WS] }, Date.now() + 60 * MINUTE_MS, proposedOpsThresholds), proposedOpsThresholds);
    t.diagnostic(`alerts: ${JSON.stringify(alerts.map((alert) => ({ kind: alert.kind, severity: alert.severity, reasonCode: alert.reasonCode, subject: alert.subject })))}`);
    assert.deepEqual(
      alerts.map((alert) => `${alert.kind}:${alert.reasonCode}:${alert.subject}`),
      [`dead_letter_growth:open_dead_letter_over_limit:${paused.request.requestId}`],
      "only the open dead letter alerts",
    );
    assert.equal(alerts[0]?.severity, "page");

    // Batch planning: the route cannot batch, so each batch request is planned as normal calls, and the report says so.
    const plans: BatchPlan[] = started.map((item) => planBatch({ priority: item.priority, provider: "openrouter" }));
    const batch = summarizeBatch(plans);
    assert.equal(batch.batchRequests, REQUESTS / BATCH_EVERY);
    assert.equal(batch.asBatch, 0, "no request is sent as a batch on this route");
    assert.equal(batch.asNormalCalls, REQUESTS / BATCH_EVERY);
    assert.match(batch.reason ?? "", /not supported on this route/);

    // Concurrency: with no provider attempts in the window, every bucket holds at its current size.
    const sizing = proposeConcurrency({
      current: { video: 10, image: 20, tts: 30 },
      nowMs: Date.now(),
      attempts: [],
      thresholds: proposedOpsThresholds.concurrency,
    });
    assert.deepEqual(
      sizing.map((proposal) => proposal.bucket),
      [...BUCKET_CLASSES],
    );
    for (const proposal of sizing) {
      assert.equal(proposal.basis, "insufficient_data");
      assert.equal(proposal.proposed, proposal.current);
    }
  });
});
