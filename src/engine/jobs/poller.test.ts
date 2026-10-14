import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError, type GateResult, type ProviderAdapter, type ProviderPoll } from "../contracts/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import type { ExecutableJob } from "../../lib/meridian/jobs/execute.ts";
import { executeEngineJob } from "./dispatch.ts";
import { decidePoll, pollBackoffMs, scheduleProviderPoll } from "./poller.ts";
import { readEngineRequest, startEngineRequest } from "./orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { EngineRuntime, EnginePayload, StageHandler, StageOutput } from "./types.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

test("the poll backoff starts at 5 seconds, doubles, and is capped at a minute (Bible 15.2)", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((step) => pollBackoffMs(step)), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.throws(() => pollBackoffMs(0), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});

test("a pending provider call waits, never past its deadline", () => {
  const submitted = 1_000_000;
  const pending: ProviderPoll = { state: "pending" };
  assert.deepEqual(decidePoll({ step: 1, submittedAtMs: submitted, nowMs: submitted, timeoutMs: 120_000, status: pending }), {
    action: "wait",
    runAfterMs: 5_000,
    nextStep: 2,
  });
  assert.deepEqual(decidePoll({ step: 3, submittedAtMs: submitted, nowMs: submitted + 115_000, timeoutMs: 120_000, status: pending }), {
    action: "wait",
    runAfterMs: 5_000,
    nextStep: 4,
  }, "the wait is the backoff while the deadline is further away");
  assert.deepEqual(decidePoll({ step: 4, submittedAtMs: submitted, nowMs: submitted + 118_000, timeoutMs: 120_000, status: pending }), {
    action: "wait",
    runAfterMs: 2_000,
    nextStep: 5,
  }, "the last wait stops at the deadline");
  assert.deepEqual(decidePoll({ step: 5, submittedAtMs: submitted, nowMs: submitted + 120_000, timeoutMs: 120_000, status: pending }), {
    action: "timed_out",
  });
});

test("a finished call is used even if it arrives after the deadline, and a failed one keeps the provider's retry flag", () => {
  const submitted = 0;
  assert.deepEqual(decidePoll({ step: 9, submittedAtMs: submitted, nowMs: 999_999, timeoutMs: 120_000, status: { state: "done", uri: "u" } }), { action: "done" });
  assert.deepEqual(
    decidePoll({
      step: 1,
      submittedAtMs: submitted,
      nowMs: 1,
      timeoutMs: 120_000,
      status: { state: "failed", error: { kind: "rate_limit", retryable: true, message: "HTTP 429" } },
    }),
    { action: "failed", retryable: true, message: "HTTP 429", refusal: null },
  );
  assert.deepEqual(
    decidePoll({ step: 1, submittedAtMs: submitted, nowMs: 1, timeoutMs: 120_000, status: { state: "failed" } }),
    { action: "failed", retryable: false, message: "the provider reported a failure without detail", refusal: null },
    "a failure with no detail is not retryable",
  );
});

/** A fake provider. Its answers are scripted per test; cancel calls are recorded. */
function fakeProvider(answer: () => ProviderPoll, options: { cancelFails?: boolean } = {}) {
  const cancelled: string[] = [];
  const adapter = {
    id: "fixture-video",
    modelClass: "video.cinematic",
    poll: async () => answer(),
    cancel: async (jobRef: string) => {
      cancelled.push(jobRef);
      if (options.cancelFails) throw new Error("provider refused the cancel");
    },
  } as unknown as ProviderAdapter;
  return { adapter, cancelled };
}

function runtimeWith(options: { adapter: ProviderAdapter | null; now: number; handlers?: Partial<EngineRuntime["handlers"]> }): EngineRuntime {
  return {
    handlers: options.handlers ?? {},
    providers: { resolve: (id: string) => (id === "fixture-video" ? options.adapter : null) },
    now: () => options.now,
  };
}

function passGate(name: GateResult["gate"], subjectId: string): GateResult {
  return { gate: name, subjectId, pass: true, checks: [{ rule: `${name}.ok`, pass: true }] };
}

/** An intake job whose result arrives later from a provider. Returns the intake payload the poll will carry. */
async function submittedIntake(n: number, submittedAt: string) {
  const organizationId = `org_poll_${n}`;
  const requestId = fixtureId("req_", 600 + n);
  await seedWorkspace(db.sql, organizationId, `brand_poll_${n}`);
  await startEngineRequest(db.sql, {
    organizationId,
    brandId: `brand_poll_${n}`,
    requestId,
    formatId: "fmt_poll",
    priority: "rush",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: fixtureId("art_", 610 + n),
  });
  const [intake] = await db.sql<ExecutableJob>`
    select id, organization_id, brand_id, job_type, payload, attempts, max_attempts from jobs
    where organization_id = ${organizationId} and job_type = 'engine.intake' limit 1
  `;
  assert.ok(intake);
  const payload = JSON.parse(intake.payload) as EnginePayload;
  const key = await scheduleProviderPoll(db.sql, {
    payload,
    provider: "fixture-video",
    jobRef: `remote-${n}`,
    submittedAt,
    parentJobId: intake.id,
  });
  assert.match(key, /^engine:/);
  return { organizationId, requestId, intakeId: intake.id };
}

async function pollRow(organizationId: string, requestId: string) {
  const [row] = await db.sql<ExecutableJob & { run_after: unknown }>`
    select id, organization_id, brand_id, job_type, payload, attempts, max_attempts from jobs
    where organization_id = ${organizationId} and job_type = 'engine.poll' and status = 'queued'
      and payload like ${`%"requestId":"${requestId}"%`}
    order by created_at asc limit 1
  `;
  assert.ok(row);
  return row;
}

test("scheduling the poll stores the external job reference on it, and a repeat does not queue a second poll", async () => {
  const { organizationId, requestId, intakeId } = await submittedIntake(1, new Date(0).toISOString());
  const row = await pollRow(organizationId, requestId);
  const payload = JSON.parse(row.payload) as { jobRef: string; provider: string; timeoutMs: number; step: number; submittedAt: string };
  assert.equal(payload.jobRef, "remote-1");
  assert.equal(payload.provider, "fixture-video");
  assert.equal(payload.timeoutMs, 120_000);
  assert.equal(payload.step, 1);
  assert.equal(payload.submittedAt, new Date(0).toISOString());
  const polls = await db.sql<{ n: number }>`
    select count(*)::int as n from jobs where organization_id = ${organizationId} and job_type = 'engine.poll'
  `;
  assert.equal(polls[0]?.n, 1);
  assert.ok(intakeId);
});

test("a poll that finds the provider still working queues the next poll and returns, so no worker waits", async () => {
  const submittedAt = new Date(Date.UTC(2026, 9, 13, 9, 0, 0)).toISOString();
  const { organizationId, requestId } = await submittedIntake(2, submittedAt);
  const row = await pollRow(organizationId, requestId);
  const { adapter } = fakeProvider(() => ({ state: "pending" }));
  const result = await executeEngineJob(db.sql, row, runtimeWith({ adapter, now: Date.parse(submittedAt) + 1_000 }));
  assert.equal(result, "pending:intake:1");
  const next = await db.sql<{ payload: string; run_after: unknown; depends_on: string; status: string }>`
    select payload, run_after, depends_on, status from jobs
    where organization_id = ${organizationId} and job_type = 'engine.poll' and status = 'queued' and depends_on = ${row.id}
  `;
  assert.equal(next.length, 1);
  assert.equal(JSON.parse(next[0]?.payload ?? "{}").step, 2);
});

test("a finished provider call finishes the stage through its finish step and advances the request", async () => {
  const submittedAt = new Date(Date.UTC(2026, 9, 13, 9, 0, 0)).toISOString();
  const { organizationId, requestId } = await submittedIntake(3, submittedAt);
  const row = await pollRow(organizationId, requestId);
  const reservation = fixtureId("res_", 630);
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${reservation}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', 0.5, 0.1, 0.6, now())
  `;
  const { adapter } = fakeProvider(() => ({ state: "done", uri: "store://fixture/intake.mp4", actualUsd: 0.02 }));
  const finished: ProviderPoll[] = [];
  const handler: StageHandler = {
    run: async () => {
      throw new Error("run is not used for a poll");
    },
    finish: async (ctx, polled) => {
      finished.push(polled);
      const output: StageOutput = {
        stage: "intake",
        subjectId: ctx.subjectId,
        gate: passGate("request", requestId),
        budgetReservationId: reservation,
        artifacts: { validated: fixtureId("art_", 631) },
      };
      return output;
    },
  };
  const result = await executeEngineJob(db.sql, row, runtimeWith({ adapter, now: Date.parse(submittedAt) + 10_000, handlers: { intake: handler } }));
  assert.equal(result, "completed:intake:2");
  assert.equal(finished[0]?.uri, "store://fixture/intake.mp4");
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.state.nodes.intake.status, "passed");
  const queued = await db.sql<{ job_type: string }>`
    select job_type from jobs where organization_id = ${organizationId} and job_type in ('engine.analyze_reference', 'engine.voice') order by job_type
  `;
  assert.deepEqual(queued.map((item) => item.job_type), ["engine.analyze_reference", "engine.voice"]);
});

test("a finished provider call with no finish step is refused, not stored as a success", async () => {
  const submittedAt = new Date(Date.UTC(2026, 9, 13, 9, 0, 0)).toISOString();
  const { organizationId, requestId } = await submittedIntake(4, submittedAt);
  const row = await pollRow(organizationId, requestId);
  const { adapter } = fakeProvider(() => ({ state: "done" }));
  const handler: StageHandler = {
    run: async () => {
      throw new Error("unused");
    },
  };
  await assert.rejects(
    executeEngineJob(db.sql, row, runtimeWith({ adapter, now: Date.parse(submittedAt) + 1_000, handlers: { intake: handler } })),
    (error: unknown) => error instanceof EngineError && error.kind === "internal",
  );
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.state.nodes.intake.status, "queued");
});

test("a provider that reports a failure fails the poll with the provider's retry flag", async () => {
  const submittedAt = new Date(Date.UTC(2026, 9, 13, 9, 0, 0)).toISOString();
  const { organizationId, requestId } = await submittedIntake(5, submittedAt);
  const row = await pollRow(organizationId, requestId);
  const { adapter } = fakeProvider(() => ({ state: "failed", error: { kind: "server", retryable: true, message: "HTTP 503" } }));
  await assert.rejects(
    executeEngineJob(db.sql, row, runtimeWith({ adapter, now: Date.parse(submittedAt) + 1_000 })),
    (error: unknown) => error instanceof EngineError && error.kind === "provider" && error.retryable === true && /HTTP 503/.test(error.message),
  );
});

test("a provider call that runs past its deadline is cancelled and fails the stage, and a failed cancel is reported", async () => {
  const submittedAt = new Date(Date.UTC(2026, 9, 13, 9, 0, 0)).toISOString();
  const { organizationId, requestId } = await submittedIntake(6, submittedAt);
  const row = await pollRow(organizationId, requestId);
  const { adapter, cancelled } = fakeProvider(() => ({ state: "pending" }), { cancelFails: true });
  await assert.rejects(
    executeEngineJob(db.sql, row, runtimeWith({ adapter, now: Date.parse(submittedAt) + 130_000 })),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "provider" &&
      error.retryable === false &&
      /did not finish within 120000 ms/.test(error.message) &&
      /cancelling the provider job also failed/.test(error.message),
  );
  assert.deepEqual(cancelled, ["remote-6"]);
});

test("a provider that is not resolvable in this runtime is a configuration error, never a silent success", async () => {
  const submittedAt = new Date(Date.UTC(2026, 9, 13, 9, 0, 0)).toISOString();
  const { organizationId, requestId } = await submittedIntake(7, submittedAt);
  const row = await pollRow(organizationId, requestId);
  await assert.rejects(
    executeEngineJob(db.sql, row, runtimeWith({ adapter: null, now: Date.parse(submittedAt) })),
    (error: unknown) => error instanceof EngineError && error.kind === "config",
  );
});
