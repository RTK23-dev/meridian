import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError, type GateResult } from "../contracts/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import type { ExecutableJob } from "../../lib/meridian/jobs/execute.ts";
import { executeJob } from "../../lib/meridian/jobs/execute.ts";
import { executeEngineJob } from "./dispatch.ts";
import { readEngineRequest, startEngineRequest } from "./orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "./test-db.ts";
import type { EngineRuntime, StageHandler, StageRunResult } from "./types.ts";
import { withTimeout } from "./types.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

function runtimeWith(handlers: Partial<EngineRuntime["handlers"]> = {}): EngineRuntime {
  return { handlers, providers: { resolve: () => null }, now: () => Date.now() };
}

function passGate(name: GateResult["gate"], subjectId: string): GateResult {
  return { gate: name, subjectId, pass: true, checks: [{ rule: `${name}.ok`, pass: true }] };
}

/** One workspace with a request started, and its intake job read back the way Meridian's worker reads it. */
async function startedRequest(n: number, extra: { attempts?: number; maxAttempts?: number } = {}) {
  const organizationId = `org_disp_${n}`;
  const brandId = `brand_disp_${n}`;
  const requestId = fixtureId("req_", 500 + n);
  await seedWorkspace(db.sql, organizationId, brandId);
  await startEngineRequest(db.sql, {
    organizationId,
    brandId,
    requestId,
    formatId: "fmt_disp",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: fixtureId("art_", 510 + n),
  });
  const [row] = await db.sql<ExecutableJob>`
    select id, organization_id, brand_id, job_type, payload, attempts, max_attempts from jobs
    where organization_id = ${organizationId} and job_type = 'engine.intake' limit 1
  `;
  assert.ok(row);
  return { organizationId, brandId, requestId, job: { ...row, attempts: extra.attempts ?? 0, max_attempts: extra.maxAttempts ?? 3 } as ExecutableJob };
}

test("a stage with no registered handler is refused as not_implemented and is never recorded as done", async () => {
  const { requestId, organizationId, job } = await startedRequest(1);
  await assert.rejects(
    executeEngineJob(db.sql, job, runtimeWith()),
    (error: unknown) => error instanceof EngineError && (error as { kind: string }).kind === "not_implemented",
  );
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "running", "the request did not move");
  assert.equal(read?.state.nodes.intake.status, "queued", "intake is still waiting, not passed");
});

test("a payload that names another workspace is refused before any handler runs", async () => {
  const { job } = await startedRequest(2);
  let called = false;
  const runtime = runtimeWith({
    intake: {
      run: async () => {
        called = true;
        throw new Error("should not run");
      },
    },
  });
  await assert.rejects(
    executeEngineJob(db.sql, { ...job, organization_id: "org_someone_else" }, runtime),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal(called, false);
});

test("a paid stage without a budget reservation is refused, and its handler is not called", async () => {
  const { requestId, organizationId } = await startedRequest(3);
  let called = false;
  const handler: StageHandler = {
    run: async () => {
      called = true;
      throw new Error("should not run");
    },
  };
  const paidJob: ExecutableJob = {
    id: "job-paid-without-reservation",
    organization_id: organizationId,
    brand_id: null,
    job_type: "engine.analyze_reference",
    payload: JSON.stringify({
      organizationId,
      requestId,
      stage: "analyze_reference",
      subjectId: requestId,
      attempt: "1",
      priority: "normal",
      budgetReservationId: null,
      inputArtifactIds: [],
      hints: [],
      details: {},
    }),
    attempts: 0,
    max_attempts: 3,
  };
  await assert.rejects(
    executeEngineJob(db.sql, paidJob, runtimeWith({ analyze_reference: handler })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal(called, false, "no provider call is made without a reservation (Bible 14)");
});

test("a finished stage applies its output once: the next jobs are queued, and a retried job changes nothing", async () => {
  const { requestId, organizationId, job, brandId } = await startedRequest(4);
  const reservation = fixtureId("res_", 530);
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${reservation}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', 0.5, 0.1, 0.6, now())
  `;
  const runtime = runtimeWith({
    intake: {
      run: async (ctx) => ({
        kind: "done",
        output: {
          stage: "intake",
          subjectId: ctx.subjectId,
          gate: passGate("request", requestId),
          budgetReservationId: reservation,
          artifacts: { validated: fixtureId("art_", 531) },
        },
      }),
    },
  });
  const first = await executeEngineJob(db.sql, job, runtime);
  assert.equal(first, "advanced:intake:2");
  const again = await executeEngineJob(db.sql, job, runtime);
  assert.equal(again, "duplicate:intake", "the same job applied twice does not advance twice");

  const queued = await db.sql<{ job_type: string; depends_on: string; brand_id: string }>`
    select job_type, depends_on, brand_id from jobs
    where organization_id = ${organizationId} and job_type in ('engine.analyze_reference', 'engine.voice') order by job_type
  `;
  assert.deepEqual(queued.map((row) => row.job_type), ["engine.analyze_reference", "engine.voice"]);
  for (const row of queued) {
    assert.equal(row.depends_on, job.id, "each depends on the intake job");
    assert.equal(row.brand_id, brandId, "the jobs carry the request's brand");
  }
});

test("a handler that answers for another stage or subject is refused, and nothing is applied", async () => {
  const { requestId, organizationId, job } = await startedRequest(5);
  const runtime = runtimeWith({
    intake: {
      run: async () => ({
        kind: "done",
        output: {
          stage: "intake",
          subjectId: fixtureId("req_", 999),
          gate: passGate("request", requestId),
          budgetReservationId: null,
          artifacts: {},
        },
      }),
    },
  });
  await assert.rejects(executeEngineJob(db.sql, job, runtime), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.state.nodes.intake.status, "queued");
});

test("a submitted provider call stores its job reference on a poll job and returns without applying a result", async () => {
  const { requestId, organizationId, job } = await startedRequest(6);
  const runtime = runtimeWith({
    intake: {
      run: async (): Promise<StageRunResult> => ({
        kind: "submitted",
        provider: "fixture-video",
        jobRef: "remote-123",
        submittedAt: new Date().toISOString(),
      }),
    },
  });
  const result = await executeEngineJob(db.sql, job, runtime);
  assert.match(result, /^submitted:intake:/);
  const polls = await db.sql<{ job_type: string; payload: string; run_after: unknown; depends_on: string }>`
    select job_type, payload, run_after, depends_on from jobs where organization_id = ${organizationId} and job_type = 'engine.poll'
  `;
  assert.equal(polls.length, 1);
  const payload = JSON.parse(polls[0]?.payload ?? "{}") as { jobRef: string; provider: string; step: number; stage: string };
  assert.equal(payload.jobRef, "remote-123");
  assert.equal(payload.provider, "fixture-video");
  assert.equal(payload.step, 1);
  assert.equal(payload.stage, "intake");
  assert.equal(polls[0]?.depends_on, job.id);
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.state.nodes.intake.status, "queued", "the stage is not finished until the poll finishes it");
});

test("a failure before the last attempt is only rethrown, so Meridian retries the job and the request keeps running", async () => {
  const { requestId, organizationId, job } = await startedRequest(7, { attempts: 0, maxAttempts: 3 });
  const runtime = runtimeWith({
    intake: {
      run: async () => {
        throw new EngineError("provider", "upstream returned 503", { retryable: true, stage: "intake" });
      },
    },
  });
  await assert.rejects(executeEngineJob(db.sql, job, runtime), /503/);
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "running");
});

test("a failure on the last attempt is recorded as a dead letter against the stage, and the error is rethrown", async () => {
  const { requestId, organizationId, job } = await startedRequest(8, { attempts: 2, maxAttempts: 3 });
  const runtime = runtimeWith({
    intake: {
      run: async () => {
        throw new Error("the queue worker lost its connection");
      },
    },
  });
  await assert.rejects(executeEngineJob(db.sql, job, runtime), /lost its connection/);
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "paused");
  assert.equal(read?.state.pause?.kind, "dead_letter");
  assert.equal(read?.state.pause?.stage, "intake");
});

test("a job that runs past its timeout fails with a retryable provider error", async () => {
  const controller = new AbortController();
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
  await assert.rejects(
    withTimeout(slow, 10, controller, "a slow stage", "intake"),
    (error: unknown) => error instanceof EngineError && error.kind === "provider" && error.retryable === true,
  );
  assert.equal(controller.signal.aborted, true, "the handler is told to stop");
});

test("the engine branch in execute.ts routes engine.* jobs here, and Meridian's own job types are unchanged", async () => {
  const { job } = await startedRequest(9);
  await assert.rejects(
    executeJob(db.sql, job),
    (error: unknown) => error instanceof EngineError && (error as { kind: string }).kind === "not_implemented",
  );
  const meridian: ExecutableJob = { ...job, id: "job-market", job_type: "market.normalize", payload: "{}", brand_id: null };
  await assert.rejects(executeJob(db.sql, meridian), /market\.normalize has no payload work/);
});
