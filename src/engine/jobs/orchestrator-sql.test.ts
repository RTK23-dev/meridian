import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError, type GateResult } from "../contracts/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import { applyEngineEvent, readEngineRequest, recordDeadEngineJobs, startEngineRequest } from "./orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

function passGate(name: GateResult["gate"], requestId: string): GateResult {
  return { gate: name, subjectId: requestId, pass: true, checks: [{ rule: `${name}.ok`, pass: true }] };
}

function failGate(name: GateResult["gate"], requestId: string): GateResult {
  return { gate: name, subjectId: requestId, pass: false, checks: [{ rule: `${name}.broken`, pass: false, detail: "claim not approved" }] };
}

/** A fresh workspace and request for one test, so tests never share rows. */
async function newRequest(n: number, options: { cachedDna?: boolean; variantCount?: number } = {}) {
  const organizationId = `org_sql_${n}`;
  const brandId = `brand_sql_${n}`;
  const requestId = fixtureId("req_", 200 + n);
  await seedWorkspace(db.sql, organizationId, brandId);
  const started = await startEngineRequest(db.sql, {
    organizationId,
    brandId,
    requestId,
    formatId: "fmt_sql",
    priority: "normal",
    cachedDna: options.cachedDna ?? false,
    variantCount: options.variantCount ?? 0,
    requestArtifactId: fixtureId("art_", 300 + n),
  });
  assert.equal(started.queued, 1);
  return { organizationId, brandId, requestId, n };
}

async function jobsOf(sql: Sql, organizationId: string, requestId: string) {
  return sql<{ id: string; job_type: string; status: string; priority: number; depends_on: string; idempotency_key: string; payload: string; max_attempts: number }>`
    select id, job_type, status, priority, depends_on, idempotency_key, payload, max_attempts from jobs
    where organization_id = ${organizationId} and payload like ${`%"requestId":"${requestId}"%`}
    order by job_type, idempotency_key
  `;
}

async function jobIdOf(sql: Sql, organizationId: string, jobType: string): Promise<string> {
  const rows = await sql<{ id: string }>`select id from jobs where organization_id = ${organizationId} and job_type = ${jobType} limit 1`;
  const id = rows[0]?.id;
  assert.ok(id, `a ${jobType} job exists`);
  return id;
}

test("starting a request writes the request row and queues intake as an engine job on the jobs table", async () => {
  const { organizationId, requestId } = await newRequest(1);
  const rows = await jobsOf(db.sql, organizationId, requestId);
  assert.equal(rows.length, 1);
  const [intake] = rows;
  assert.ok(intake);
  assert.equal(intake.job_type, "engine.intake");
  assert.equal(intake.status, "queued");
  assert.equal(intake.priority, 100);
  assert.equal(intake.max_attempts, 3);
  assert.equal(intake.idempotency_key, `engine:${requestId}:intake:${requestId}:1`);
  assert.equal(intake.depends_on, "");
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "running");
  assert.equal(read?.currentStage, "intake");
});

test("a request id that already exists is refused as a conflict, and nothing is queued twice", async () => {
  const { organizationId, brandId, requestId } = await newRequest(2);
  await assert.rejects(
    startEngineRequest(db.sql, {
      organizationId,
      brandId,
      requestId,
      formatId: "fmt_sql",
      priority: "normal",
      cachedDna: false,
      variantCount: 0,
      requestArtifactId: fixtureId("art_", 302),
    }),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
  );
  assert.equal((await jobsOf(db.sql, organizationId, requestId)).length, 1);
});

test("a passing intake with a reservation queues analysis and voice on the request, each depending on intake", async () => {
  const { organizationId, requestId, n } = await newRequest(3);
  const reservationId = fixtureId("res_", 400 + n);
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${reservationId}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', 0.5, 0.1, 0.6, now())
  `;
  const intakeJob = await jobIdOf(db.sql, organizationId, "engine.intake");
  const applied = await applyEngineEvent(db.sql, {
    organizationId,
    requestId,
    triggerJobId: intakeJob,
    dedupeKey: `job:${intakeJob}`,
    event: {
      type: "succeeded",
      output: { stage: "intake", subjectId: requestId, gate: passGate("request", requestId), budgetReservationId: reservationId, artifacts: { validated: fixtureId("art_", 401) } },
    },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.queued, 2);
  const rows = await jobsOf(db.sql, organizationId, requestId);
  const analysis = rows.find((row) => row.job_type === "engine.analyze_reference");
  const voice = rows.find((row) => row.job_type === "engine.voice");
  assert.ok(analysis && voice);
  assert.equal(analysis.depends_on, intakeJob);
  assert.equal(voice.depends_on, intakeJob);
  assert.equal(JSON.parse(analysis.payload).budgetReservationId, reservationId);
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.state.budgetReservationId, reservationId);
});

test("a repeated job completion is applied once: the same dedupe key changes nothing the second time", async () => {
  const { organizationId, requestId } = await newRequest(4);
  const reservationId = fixtureId("res_", 404);
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${reservationId}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', 0.5, 0.1, 0.6, now())
  `;
  const intakeJob = await jobIdOf(db.sql, organizationId, "engine.intake");
  const event = {
    type: "succeeded" as const,
    output: { stage: "intake" as const, subjectId: requestId, gate: passGate("request", requestId), budgetReservationId: reservationId, artifacts: {} },
  };
  const first = await applyEngineEvent(db.sql, { organizationId, requestId, event, triggerJobId: intakeJob, dedupeKey: `job:${intakeJob}` });
  const second = await applyEngineEvent(db.sql, { organizationId, requestId, event, triggerJobId: intakeJob, dedupeKey: `job:${intakeJob}` });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal((await jobsOf(db.sql, organizationId, requestId)).filter((row) => row.job_type === "engine.voice").length, 1);
});

test("a request is only visible to its own workspace: another workspace cannot advance or read it", async () => {
  const { requestId } = await newRequest(5);
  const intruder = "org_sql_intruder";
  await seedWorkspace(db.sql, intruder);
  await assert.rejects(
    applyEngineEvent(db.sql, { organizationId: intruder, requestId, event: { type: "resume" } }),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
  assert.equal(await readEngineRequest(db.sql, intruder, requestId), null);
});

test("a failing intake rejects the request, persists its gate result, and queues nothing", async () => {
  const { organizationId, requestId } = await newRequest(6);
  const intakeJob = await jobIdOf(db.sql, organizationId, "engine.intake");
  const applied = await applyEngineEvent(db.sql, {
    organizationId,
    requestId,
    triggerJobId: intakeJob,
    dedupeKey: `job:${intakeJob}`,
    event: { type: "succeeded", output: { stage: "intake", subjectId: requestId, gate: failGate("request", requestId), budgetReservationId: null, artifacts: {} } },
  });
  assert.equal(applied.status, "rejected");
  assert.equal(applied.queued, 0);
  const gates = await db.sql<{ gate: string; passed: boolean }>`select gate, passed from engine_gate_results where request_id = ${requestId}`;
  assert.deepEqual(gates, [{ gate: "request", passed: false }]);
});

test("an intake without a reservation advances, then the request pauses on analysis, the first paid stage, and no paid job reaches the jobs table", async () => {
  const { organizationId, requestId } = await newRequest(7);
  const intakeJob = await jobIdOf(db.sql, organizationId, "engine.intake");
  await applyEngineEvent(db.sql, {
    organizationId,
    requestId,
    triggerJobId: intakeJob,
    dedupeKey: `job:${intakeJob}`,
    event: { type: "succeeded", output: { stage: "intake", subjectId: requestId, gate: passGate("request", requestId), budgetReservationId: null, artifacts: {} } },
  });
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "paused");
  assert.equal(read?.state.pause?.kind, "budget");
  assert.equal(read?.state.pause?.stage, "analyze_reference");
  assert.equal(read?.state.nodes.intake.status, "passed");
  const rows = await jobsOf(db.sql, organizationId, requestId);
  assert.deepEqual(rows.map((row) => row.job_type), ["engine.intake"]);
});

test("an escalation writes a review item carrying its detail, and the request is paused", async () => {
  const { organizationId, requestId } = await newRequest(8);
  const reservationId = fixtureId("res_", 408);
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${reservationId}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', 0.5, 0.1, 0.6, now())
  `;
  const intakeJob = await jobIdOf(db.sql, organizationId, "engine.intake");
  await applyEngineEvent(db.sql, {
    organizationId,
    requestId,
    triggerJobId: intakeJob,
    dedupeKey: `job:${intakeJob}`,
    event: { type: "succeeded", output: { stage: "intake", subjectId: requestId, gate: passGate("request", requestId), budgetReservationId: reservationId, artifacts: {} } },
  });
  await applyEngineEvent(db.sql, {
    organizationId,
    requestId,
    event: { type: "succeeded", output: { stage: "analyze_reference", subjectId: requestId, gate: failGate("dna", requestId), artifacts: {} } },
    dedupeKey: "analyze:first-fail",
  });
  await applyEngineEvent(db.sql, {
    organizationId,
    requestId,
    event: { type: "succeeded", output: { stage: "analyze_reference", subjectId: requestId, gate: failGate("dna", requestId), artifacts: {} } },
    dedupeKey: "analyze:second-fail",
  });
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "paused");
  const reviews = await db.sql<{ kind: string; status: string; reason: string }>`
    select kind, status, reason from engine_review_items where request_id = ${requestId}
  `;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.kind, "escalation");
  assert.equal(reviews[0]?.status, "open");
});

test("a dead engine job that the engine never saw is recorded once by the sweep, and the request pauses", async () => {
  const { organizationId, requestId } = await newRequest(9);
  const intakeJob = await jobIdOf(db.sql, organizationId, "engine.intake");
  await db.sql`update jobs set status = 'dead', last_error = 'Lease expired before the worker finished.' where id = ${intakeJob}`;
  const first = await recordDeadEngineJobs(db.sql);
  const outcome = first.find((item) => item.jobId === intakeJob);
  assert.equal(outcome?.outcome, "applied");
  const read = await readEngineRequest(db.sql, organizationId, requestId);
  assert.equal(read?.status, "paused", "a dead job pauses the request as a dead letter (Bible 15.5)");
  assert.equal(read?.state.pause?.kind, "dead_letter");
  const pauseRow = await db.sql<{ pause_reason: string }>`select pause_reason from engine_requests where id = ${requestId}`;
  assert.match(pauseRow[0]?.pause_reason ?? "", /Lease expired/);
  const second = await recordDeadEngineJobs(db.sql);
  assert.equal(second.find((item) => item.jobId === intakeJob), undefined, "a recorded job is not listed as new work again");
});

test("the engine tables carry the workspace column and reject a row whose request is in another workspace", async () => {
  const { requestId } = await newRequest(10);
  await seedWorkspace(db.sql, "org_sql_other");
  await assert.rejects(
    db.sql`
      insert into engine_gate_results (id, organization_id, request_id, gate, subject_id, passed, checks)
      values ('gr_x', 'org_sql_other', ${requestId}, 'request', ${requestId}, true, '[]')
    `,
  );
});
