import assert from "node:assert/strict";
import test from "node:test";
import { LEARN_NOT_BUILT } from "./pipeline.ts";
import { executeFactoryJob } from "./worker.ts";
import {
  factoryJob,
  factoryRunRow,
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

test("a full run that reaches every stage is never marked succeeded: learning is not built, so the run stays running with the reason", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedJobRow(sql, "job-discover-finish", "factory.discover");

  await withFixtureFetch(() =>
    executeFactoryJob(sql, factoryJob("factory.discover", "job-discover-finish"), { runId: FACTORY_TEST_RUN }, fixtureGatherDeps({ metaToken: null })),
  );
  assert.notEqual((await factoryRunRow(sql)).status, "succeeded", "gathering does not finish the run");

  for (const stage of STAGES_AFTER_DISCOVER) {
    await executeFactoryJob(sql, factoryJob(stage), { runId: FACTORY_TEST_RUN });
    const row = await factoryRunRow(sql);
    assert.notEqual(row.status, "succeeded", `the run must not read finished after ${stage}`);
  }

  // The budget test records what it would do and waits for a person, so the run stops there, and learning is held behind it. The run is
  // waiting, not finished. Learning's own reason is checked by the learn test below.
  const finished = await factoryRunRow(sql);
  assert.equal(finished.status, "awaiting_approval", "the budget test waits for a person in every mode");
  assert.equal(finished.current_stage, "factory.test");
  assert.match(finished.error, /budget test is recorded for a person to approve/, "the reason the run waits is on the run row");
  assert.notEqual(finished.error, LEARN_NOT_BUILT, "learning has not been reached, so its reason is not on the row");
});

test("learn returns the reason and writes it to the run row, and nothing else", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  const result = await executeFactoryJob(sql, factoryJob("factory.learn"), { runId: FACTORY_TEST_RUN });
  assert.equal(result, "learn:not-built");
  assert.equal((await factoryRunRow(sql)).status, "running");
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
