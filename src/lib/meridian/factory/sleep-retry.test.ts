// A sleep night that fails can be retried; the stages it finished are not run again; a night that finished is not run again.
// The database is PGlite with the migrations, so the night's rows are the real ones. The factory stages are replaced by the stage
// seam (SleepSeams.stage): no stage does real work and no provider is called.

import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutableJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";
import { FACTORY_TEST_BRAND, FACTORY_TEST_ORG, makeFactoryTestSql, seedFactoryRun } from "../testing/factory-fixtures.ts";
import { runSleepNight } from "./sleep.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const NIGHT_KEY = "2026-10-15";
const STAGES = [
  "factory.discover",
  "factory.ingest",
  "factory.decode",
  "factory.grade",
  "factory.trend",
  "factory.pick",
  "factory.template",
];

async function seedSleepMode(sql: Sql): Promise<void> {
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "sleep aids", website: "", country: "us" });
  await sql`
    insert into sleep_mode_settings (organization_id, brand_id, enabled, night_time, time_zone, niche, updated_by)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, true, '03:00', 'UTC', 'sleep aids', 'user-1')
  `;
  await sql`
    insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 0, 5000, 'user-1')
  `;
}

/** A job row of the queue, with its lease: live for a minute, or expired a minute ago. */
async function seedSleepJob(sql: Sql, id: string, lease: "live" | "expired"): Promise<void> {
  const leaseUntil = new Date(Date.now() + (lease === "live" ? 60_000 : -60_000)).toISOString();
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, lease_until)
    values (${id}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'factory.sleep', ${`test:${id}`}, 'running', '{}', 3,
      ${leaseUntil}::timestamptz)
  `;
}

function jobFor(id: string): ExecutableJob {
  return { id, organization_id: FACTORY_TEST_ORG, brand_id: FACTORY_TEST_BRAND, job_type: "factory.sleep", payload: "{}", attempts: 1, max_attempts: 3 };
}

/** Stands in for each factory stage. Discover writes an ok source, as the real discover stage does, and every stage is recorded. */
function recordingStages() {
  const calls: string[] = [];
  const seam = async (db: Sql, _job: ExecutableJob, payload: Record<string, unknown>): Promise<string> => {
    const stage = String(payload.stage);
    calls.push(stage);
    if (stage === "factory.discover") {
      await db`
        insert into factory_run_sources (run_id, organization_id, brand_id, source, state, reason, items)
        values (${String(payload.runId)}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'instagram_volume', 'ok', '', 3)
      `;
    }
    return `ok:${stage}`;
  };
  return { calls, seam };
}

/** The database as the night sees it, with one statement that fails once, as a dropped connection would. */
function dropOnce(sql: Sql, statement: string): Sql {
  let dropped = false;
  const wrapped = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!dropped && strings.join("?").includes(statement)) {
      dropped = true;
      throw new Error("The database connection dropped.");
    }
    return sql(strings, ...values);
  }) as Sql;
  wrapped.query = sql.query;
  if (sql.begin) wrapped.begin = sql.begin;
  return wrapped;
}

async function nightRow(sql: Sql) {
  const rows = await sql<{ id: string; status: string; run_id: string; stages: string; reason: string }>`
    select id, status, run_id, stages, reason from sleep_mode_nights where organization_id = ${FACTORY_TEST_ORG} and night_key = ${NIGHT_KEY}
  `;
  assert.equal(rows.length, 1, "one row per night");
  return rows[0];
}

async function setNightRunning(sql: Sql): Promise<void> {
  // The night as a worker that died before it could record a failure leaves it: running, with its run still running.
  await sql`update sleep_mode_nights set status = 'running', finished_at = null where organization_id = ${FACTORY_TEST_ORG}`;
  await sql`update factory_runs set status = 'running' where organization_id = ${FACTORY_TEST_ORG}`;
}

/** A night whose first attempt failed after discover had finished: the database dropped while it read the run's sources. */
async function failedNight(sql: Sql, jobId: string): Promise<{ runId: string; firstCalls: string[] }> {
  const first = recordingStages();
  await assert.rejects(
    runSleepNight(dropOnce(sql, "from factory_run_sources"), jobFor(jobId), NOW, { stage: first.seam }),
    /The database connection dropped/,
  );
  assert.deepEqual(first.calls, ["factory.discover"], "only discover had finished when the attempt failed");
  return { runId: (await nightRow(sql)).run_id, firstCalls: first.calls };
}

test("a failed night is retried by the same job: it runs, the stages it finished are not run again, and the run is not left running", async () => {
  const sql = await makeFactoryTestSql();
  await seedSleepMode(sql);
  const { runId } = await failedNight(sql, "job_1");

  const failed = await nightRow(sql);
  assert.equal(failed.status, "failed");
  assert.notEqual(runId, "", "the run the night began is recorded before the failure");
  const failedRun = await sql<{ status: string }>`select status from factory_runs where id = ${runId}`;
  assert.equal(failedRun[0]?.status, "failed", "a failed night does not leave its run running");

  // The queue retries the same job. Discover is not run again; every other stage runs once.
  const retry = recordingStages();
  assert.equal(await runSleepNight(sql, jobFor("job_1"), NOW, { stage: retry.seam }), "sleep:stopped");
  assert.deepEqual(retry.calls, STAGES.slice(1), "the retry runs the stages after discover, and only them");

  const done = await nightRow(sql);
  assert.equal(done.status, "stopped", "the night ran to its end");
  assert.equal(done.run_id, runId, "the retry continues the same run, so the candidates discover stored are kept");
  assert.match(done.reason, /No concept was picked tonight/);
  const stages = JSON.parse(done.stages) as Array<{ stage: string; result: string }>;
  assert.deepEqual(stages.map((record) => record.stage), STAGES, "the night records each stage once, in order");
  const finishedRun = await sql<{ status: string }>`select status from factory_runs where id = ${runId}`;
  assert.equal(finishedRun[0]?.status, "paused", "the run takes the status the night gave it");
});

test("a night that finished is not run again, whichever job asks", async () => {
  const sql = await makeFactoryTestSql();
  await seedSleepMode(sql);
  const first = recordingStages();
  assert.equal(await runSleepNight(sql, jobFor("job_1"), NOW, { stage: first.seam }), "sleep:stopped");
  assert.equal(first.calls.length, STAGES.length);

  const again = recordingStages();
  assert.equal(await runSleepNight(sql, jobFor("job_2"), NOW, { stage: again.seam }), `sleep:already-ran:${NIGHT_KEY}`);
  assert.deepEqual(again.calls, [], "no stage runs for a night that finished");
  assert.equal((await nightRow(sql)).status, "stopped", "the finished night keeps its status");
});

test("a night a dead worker left running is resumed when no other sleep job is live", async () => {
  const sql = await makeFactoryTestSql();
  await seedSleepMode(sql);
  await seedSleepJob(sql, "job_dead", "expired");
  await failedNight(sql, "job_dead");
  await setNightRunning(sql);

  const retry = recordingStages();
  assert.equal(await runSleepNight(sql, jobFor("job_dead"), NOW, { stage: retry.seam }), "sleep:stopped");
  assert.deepEqual(retry.calls, STAGES.slice(1));
});

test("a night another sleep job is still running is not run a second time", async () => {
  const sql = await makeFactoryTestSql();
  await seedSleepMode(sql);
  await seedSleepJob(sql, "job_live", "live");
  await failedNight(sql, "job_first");
  await setNightRunning(sql);

  const other = recordingStages();
  assert.equal(await runSleepNight(sql, jobFor("job_new"), NOW, { stage: other.seam }), `sleep:already-ran:${NIGHT_KEY}`);
  assert.deepEqual(other.calls, [], "the live job's night is not taken over");
  assert.equal((await nightRow(sql)).status, "running", "the live job's night stays running");
});

test("two executions retrying the same failed night at once: one runs it, and the other does not", async () => {
  const sql = await makeFactoryTestSql();
  await seedSleepMode(sql);
  await seedSleepJob(sql, "job_a", "live");
  await seedSleepJob(sql, "job_b", "live");
  await failedNight(sql, "job_first");

  const a = recordingStages();
  const b = recordingStages();
  const results = await Promise.all([
    runSleepNight(sql, jobFor("job_a"), NOW, { stage: a.seam }),
    runSleepNight(sql, jobFor("job_b"), NOW, { stage: b.seam }),
  ]);
  assert.equal(results.filter((result) => result === "sleep:stopped").length, 1, "exactly one execution ran the night");
  assert.equal(results.filter((result) => result === `sleep:already-ran:${NIGHT_KEY}`).length, 1, "the other was refused");
  assert.equal(a.calls.length + b.calls.length, STAGES.length - 1, "each stage after discover runs once, across both executions");
});
