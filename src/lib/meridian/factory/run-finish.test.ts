import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { LEARN_WAITING } from "./pipeline.ts";
import { executeFactoryJob } from "./worker.ts";
import {
  factoryJob,
  factoryRunRow,
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  FIXTURE_BRAND_WEBSITE,
  fixtureGatherDeps,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
  withFixtureFetch,
} from "../testing/factory-fixtures.ts";

const FULL_WITH_CAP = {
  automation: "full",
  caps: { dailyCents: 1000, totalCents: 5000, maxVariants: 8 },
};

const MANUAL = { automation: "manual" };

/** Every stage after discover, in graph order. */
const STAGES_AFTER_DISCOVER = [
  "factory.ingest",
  "factory.decode",
  "factory.grade",
  "factory.trend",
  "factory.pick",
  "factory.template",
  "factory.produce",
  "factory.gate",
  "factory.review",
  "factory.launch",
  "factory.test",
  "factory.learn",
] as const;

test("a full run that reaches every stage is not marked succeeded without a measured outcome of its own: learning waits, so the run stays running with the reason", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedJobRow(sql, "job-discover-finish", "factory.discover");

  await withFixtureFetch(() =>
    executeFactoryJob(sql, factoryJob("factory.discover", "job-discover-finish"), { runId: FACTORY_TEST_RUN }, fixtureGatherDeps({ metaToken: null })),
  );
  assert.notEqual((await factoryRunRow(sql)).status, "succeeded", "gathering does not finish the run");

  // A stop that waits for a person is approved here, as approveFactoryStage records it, and the stage runs again from its wait. Every
  // stop is approved once, so the run reaches learning.
  for (const stage of STAGES_AFTER_DISCOVER) {
    await executeFactoryJob(sql, factoryJob(stage), { runId: FACTORY_TEST_RUN });
    let row = await factoryRunRow(sql);
    if (row.status === "awaiting_approval") {
      assert.equal(row.current_stage, stage, "the run waits at the stage that ran");
      await approveStop(sql, stage);
      await executeFactoryJob(sql, factoryJob(stage), { runId: FACTORY_TEST_RUN });
      row = await factoryRunRow(sql);
    }
    assert.notEqual(row.status, "succeeded", `the run must not read finished after ${stage}`);
    assert.notEqual(row.status, "awaiting_approval", `${stage} runs once it is approved`);
  }

  // Learning is reached. The run has no measured outcome of its own, so it waits: running, never finished, with the reason on the row.
  const finished = await factoryRunRow(sql);
  assert.equal(finished.status, "running", "no measured outcome of the run's own yet, so the run stays running");
  assert.equal(finished.current_stage, "factory.learn");
  assert.equal(finished.error, LEARN_WAITING, "the reason the run is unfinished is on the run row");
});

/** A person's approval of one stop, recorded the way approveFactoryStage records it, and the run released from its wait. */
async function approveStop(sql: Sql, stage: string): Promise<void> {
  await sql`
    insert into factory_approvals (id, organization_id, brand_id, run_id, stage, approved_by)
    values (${`approval-${stage}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, ${stage}, 'user-1')
  `;
  await sql`
    update factory_runs set status = 'queued', error = '', updated_at = now()
    where id = ${FACTORY_TEST_RUN} and status = 'awaiting_approval'
  `;
}

test("learn with no measured outcome of the run's own waits, writes the reason to the run row, and finishes nothing", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  const result = await executeFactoryJob(sql, factoryJob("factory.learn"), { runId: FACTORY_TEST_RUN });
  assert.match(result, /^learn:waiting;organic 0 patterns from 0 outcomes; paid 0 patterns from 0 outcomes$/);
  const row = await factoryRunRow(sql);
  assert.equal(row.status, "running");
  assert.equal(row.error, LEARN_WAITING);
});

test("learn finishes the run once one of its own creatives has a measured paid outcome, and the run reads finished", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  await sql`
    insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard)
    values ('tpl-1', 'org-factory', 'brand-factory', 'ad-1', '{}')
  `;
  await sql`
    insert into factory_variants (id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result)
    values ('var-1', 'org-factory', 'brand-factory', 'tpl-1', 'question', 'shop', 'founder', 9000, 'pass')
  `;
  await sql`
    insert into factory_creatives (organization_id, brand_id, run_id, variant_id, format, creative_id, production_job_id, provider)
    values ('org-factory', 'brand-factory', 'run-factory', 'var-1', 'image', 'cr-1', 'job-p', 'test')
  `;
  // A paid measurement of the run's creative, as the measurement pull stores it. Impressions and spend are measured; nothing else is.
  await sql`
    insert into unified_performance_telemetry (id, organization_id, brand_id, platform, source_type, creative_id, impressions, clicks, conversions, spend_cents)
    values ('tel-1', 'org-factory', 'brand-factory', 'meta', 'paid', 'cr-1', 1000, 50, 2, 800)
  `;
  const result = await executeFactoryJob(sql, factoryJob("factory.learn"), { runId: FACTORY_TEST_RUN });
  assert.match(result, /^learned:\d+;run outcomes organic 0, paid 1;/);
  const row = await factoryRunRow(sql);
  assert.equal(row.status, "succeeded", "a measured outcome of the run's own creatives finishes the run");
  assert.equal(row.error, "");
});

test("a level 0 run that builds its templates is not finished by the template stage", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  const result = await executeFactoryJob(sql, factoryJob("factory.template"), { runId: FACTORY_TEST_RUN });
  assert.equal(result, "templates:0;plans:0;refused:0", "no pick is stored, so no template or plan is written");
  const row = await factoryRunRow(sql);
  assert.notEqual(row.status, "succeeded", "a template stage that did not finish the work does not finish the run");
  assert.equal(row.status, "running");
});

test("review reports the variants waiting for a person and leaves the run where the stop points put it", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  await sql`
    insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard)
    values ('tpl-1', 'org-factory', 'brand-factory', 'ad-1', '{}')
  `;
  await sql`
    insert into factory_variants (id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result)
    values ('var-1', 'org-factory', 'brand-factory', 'tpl-1', 'question', 'shop', 'founder', 9000, 'review'),
           ('var-2', 'org-factory', 'brand-factory', 'tpl-1', 'question', 'learn', 'founder', 9000, 'pass')
  `;
  const result = await executeFactoryJob(sql, factoryJob("factory.review"), { runId: FACTORY_TEST_RUN });
  assert.equal(result, "review:1");
  const row = await factoryRunRow(sql);
  assert.equal(row.status, "running", "review does not finish the run");
});

test("a manual run waits at produce, and the wait is awaiting approval, never finished", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  for (const stage of ["factory.ingest", "factory.decode", "factory.grade", "factory.trend", "factory.pick", "factory.template"] as const) {
    await executeFactoryJob(sql, factoryJob(stage), { runId: FACTORY_TEST_RUN });
  }
  const result = await executeFactoryJob(sql, factoryJob("factory.produce"), { runId: FACTORY_TEST_RUN });
  assert.equal(result, "awaiting-approval:factory.produce");
  const row = await factoryRunRow(sql);
  assert.equal(row.status, "awaiting_approval");
  assert.notEqual(row.status, "succeeded");
});
