import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionRequest, DecisionResult, DecisionUsage } from "../decisions/types.ts";
import type { Sql } from "../learning/store.ts";
import { FixtureDecisionEngine } from "../testing/decision-fixtures.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  factoryJob,
  factoryRunRow,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
} from "../testing/factory-fixtures.ts";
import { CREATIVE_DNA_VERSION, dnaField, emptyCreativeDna, type AdFormat } from "./creative-dna.ts";
import { cappedGradeReason } from "./grade.ts";
import { TOKEN_PRICES } from "./price-table.ts";
import { KILL_SWITCH_STOP_REASON } from "./stage-decision.ts";
import { executeFactoryJob, type FactorySeams } from "./worker.ts";

// The engine is named, so a deployment's DECISION_ENGINE value cannot change which fixture is asked.
const OPENAI_RUN = { automation: "manual", decisionEngine: "openai-decisions" };
const COLLECT_JOB = "job-research-collect";
const NOT_CONFIGURED = { status: "NOT_CONFIGURED" as const, message: "No key is saved for this workspace." };
// The engine's priced model comes from the price table, so the test names no model. That model is charged $0.10 per million input
// tokens, so one million input tokens cost 10 cents. Each call reports this usage.
const PRICED_MODEL = TOKEN_PRICES.find((entry) => entry.engineId === "openai-decisions")?.model ?? "";
const TEN_CENTS_PER_CALL: DecisionUsage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 };
const TOTAL_CAP_REASON = "The spend cap for this run is reached.";
const DAILY_CAP_REASON = "The daily spend cap for this brand is reached.";

/** Ads with stored creative DNA, one concept each, so every ad is asked the same questions. The ids are given in order. */
async function seedAds(sql: Sql, ids: string[]): Promise<void> {
  await seedJobRow(sql, COLLECT_JOB, "factory.discover");
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values ('collect-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${COLLECT_JOB}, 'skincare', 'US', 'succeeded', 'user-1')
  `;
  for (const [index, id] of ids.entries()) {
    await sql`
      insert into research_ads (
        id, organization_id, brand_id, collection_run_id, source, external_id, page_id, advertiser, original_url,
        captured_at, published_at, copy, platforms, source_metrics
      ) values (
        ${id}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'collect-1', 'meta_ad_library', ${`ext-${id}`}, ${`page-${id}`},
        'Rival Co', 'https://example.com/ad', ${`2026-10-0${index + 1}T00:00:00.000Z`}, '2026-09-01T00:00:00.000Z',
        'Dry hands? Try the gentle serum.', '["facebook"]', '{"stoppedAt": null, "countries": ["US"]}'
      )
    `;
    const dna = emptyCreativeDna(id, 15000);
    dna.format = dnaField<AdFormat>("demo", 0.8, { kind: "transcript" });
    dna.hook.type = dnaField("question", 0.8, { kind: "transcript" });
    dna.angle = dnaField("problem-solution", 0.8, { kind: "transcript" });
    await sql`
      insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record)
      values (${`dna:${id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${id}, ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)})
    `;
  }
  await sql`
    insert into brand_brains (brand_id, positioning, tone, target_customers, prohibited_claims, updated_by)
    values (${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'warm and plain', 'adults with dry skin', 'cures eczema', 'user-1')
  `;
}

async function setBrandCaps(sql: Sql, caps: { dailyCents: number; totalCents: number }): Promise<void> {
  await sql`
    insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${caps.dailyCents}, ${caps.totalCents}, 'user-1')
  `;
}

/** An OpenAI Decisions fixture that answers every question the same way and reports the given usage on each call. */
function engineWith(usage?: DecisionUsage): FixtureDecisionEngine {
  return new FixtureDecisionEngine({
    id: "openai-decisions",
    model: PRICED_MODEL,
    ...(usage ? { usage } : {}),
    respond: (spec) => (spec.type === "choice" ? { choice: "low_risk", confidence: 0.9 } : { probability: 0.99 }),
  });
}

/**
 * An engine that engages the workspace kill switch on its first call, as an operator would while a grade is running. The switch is
 * written with the database handle the test gives it, so the next ad's check reads it.
 */
class KillSwitchOnFirstCall extends FixtureDecisionEngine {
  readonly switchSql: Sql;
  switched: boolean;

  constructor(switchSql: Sql) {
    super({
      id: "openai-decisions",
      model: PRICED_MODEL,
      respond: (spec) => (spec.type === "choice" ? { choice: "low_risk", confidence: 0.9 } : { probability: 0.99 }),
    });
    this.switchSql = switchSql;
    this.switched = false;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (!this.switched) {
      this.switched = true;
      await this.switchSql`
        insert into factory_kill_switches (organization_id, brand_id, scope, engaged, actor_id)
        values (${FACTORY_TEST_ORG}, null, 'workspace', true, 'user-1')
      `;
    }
    return super.decide(request);
  }
}

function seamsWith(engine: FixtureDecisionEngine): FactorySeams {
  return {
    decisionEngines: {
      jev: new FixtureDecisionEngine({ health: NOT_CONFIGURED }),
      "openai-decisions": engine,
    },
  };
}

function runGrade(sql: Sql, engine: FixtureDecisionEngine): Promise<string> {
  return executeFactoryJob(sql, factoryJob("factory.grade"), { runId: FACTORY_TEST_RUN }, undefined, seamsWith(engine));
}

type TimelineGrade = { research_ad_id: string; jev_status: string; jev_reason: string };

async function gradesOf(sql: Sql): Promise<TimelineGrade[]> {
  return sql<TimelineGrade>`
    select research_ad_id, jev_status, jev_reason from ad_timelines
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND} and graded_by_run_id = ${FACTORY_TEST_RUN}
    order by research_ad_id
  `;
}

/** The engine calls one ad's grade makes, measured in a workspace where nothing stops the stage. */
async function engineCallsForOneAd(): Promise<number> {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedAds(sql, ["ad-1"]);
  const engine = engineWith(TEN_CENTS_PER_CALL);
  assert.equal(await runGrade(sql, engine), "graded:1");
  assert.ok(engine.requests.length > 0, "one ad is asked at least once");
  return engine.requests.length;
}

test("with no cap reached and no kill switch, the grade stage grades every ad and the run keeps going", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedAds(sql, ["ad-1", "ad-2"]);
  const engine = engineWith(TEN_CENTS_PER_CALL);

  assert.equal(await runGrade(sql, engine), "graded:2");
  assert.deepEqual((await gradesOf(sql)).map((row) => row.jev_status), ["engine", "engine"], "both ads are graded by the engine");
  const run = await factoryRunRow(sql);
  assert.equal(run.status, "running", "a stage that is not stopped leaves the run running");
  assert.equal(run.error, "");
});

test("a total cap reached during the stage refuses the next ad's engine call, records the reason on that ad, and pauses the run", async () => {
  const perAd = await engineCallsForOneAd();
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await setBrandCaps(sql, { dailyCents: 0, totalCents: 10 });
  await seedAds(sql, ["ad-1", "ad-2"]);
  const engine = engineWith(TEN_CENTS_PER_CALL);

  assert.equal(await runGrade(sql, engine), "stopped:factory.grade");
  assert.equal(engine.requests.length, perAd, "the first ad's calls reached the cap, and the second ad made no engine call");
  const grades = await gradesOf(sql);
  assert.deepEqual(grades.map((row) => row.jev_status).sort(), ["engine", "observed_only"]);
  const refused = grades.find((row) => row.jev_status === "observed_only");
  assert.equal(refused?.jev_reason, cappedGradeReason(TOTAL_CAP_REASON), "the refused ad records the reason it got no grade");
  const run = await factoryRunRow(sql);
  assert.equal(run.status, "paused");
  assert.equal(run.current_stage, "factory.grade");
  assert.equal(run.error, TOTAL_CAP_REASON, "the run row carries the cap's reason");
});

test("a daily cap reached during the stage refuses the next ad's engine call the same way", async () => {
  const perAd = await engineCallsForOneAd();
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await setBrandCaps(sql, { dailyCents: 10, totalCents: 0 });
  await seedAds(sql, ["ad-1", "ad-2"]);
  const engine = engineWith(TEN_CENTS_PER_CALL);

  assert.equal(await runGrade(sql, engine), "stopped:factory.grade");
  assert.equal(engine.requests.length, perAd, "the second ad made no engine call");
  const refused = (await gradesOf(sql)).find((row) => row.jev_status === "observed_only");
  assert.equal(refused?.jev_reason, cappedGradeReason(DAILY_CAP_REASON));
  const run = await factoryRunRow(sql);
  assert.equal(run.status, "paused");
  assert.equal(run.error, DAILY_CAP_REASON);
});

test("a kill switch engaged during the stage refuses the next ad's engine call", async () => {
  const perAd = await engineCallsForOneAd();
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedAds(sql, ["ad-1", "ad-2"]);
  const engine = new KillSwitchOnFirstCall(sql);

  assert.equal(await runGrade(sql, engine), "stopped:factory.grade");
  assert.equal(engine.requests.length, perAd, "the second ad made no engine call once the switch was engaged");
  const refused = (await gradesOf(sql)).find((row) => row.jev_status === "observed_only");
  assert.equal(refused?.jev_reason, cappedGradeReason(KILL_SWITCH_STOP_REASON));
  const run = await factoryRunRow(sql);
  assert.equal(run.status, "paused");
  assert.equal(run.error, KILL_SWITCH_STOP_REASON);
});

test("a cap already reached when the stage starts refuses every ad's call: no call is made, each ad records the reason, and the run pauses", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await setBrandCaps(sql, { dailyCents: 0, totalCents: 10 });
  await seedAds(sql, ["ad-1", "ad-2"]);
  // Ten cents were already spent on this run. Grade is not a spend stage, so the stage starts and each ad's call is checked.
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, basis, created_at)
    values ('spend:earlier', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, 'factory.produce', 10, 0, 'meta', 'provider_reported', now())
  `;
  const engine = engineWith(TEN_CENTS_PER_CALL);

  assert.equal(await runGrade(sql, engine), "stopped:factory.grade");
  assert.equal(engine.requests.length, 0, "no provider call was made");
  const grades = await gradesOf(sql);
  assert.deepEqual(grades.map((row) => row.jev_status), ["observed_only", "observed_only"]);
  assert.ok(grades.every((row) => row.jev_reason === cappedGradeReason(TOTAL_CAP_REASON)), "each ad records the reason");
  const run = await factoryRunRow(sql);
  assert.equal(run.status, "paused");
  assert.equal(run.error, TOTAL_CAP_REASON);
});

test("a capped ad keeps the engine grade an earlier run stored, and makes no call", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedAds(sql, ["ad-1", "ad-2"]);
  // An earlier grade of the same run, with its spend recorded. Then the brand's cap is set below that spend.
  assert.equal(await runGrade(sql, engineWith(TEN_CENTS_PER_CALL)), "graded:2");
  const before = await gradesOf(sql);
  assert.deepEqual(before.map((row) => row.jev_status), ["engine", "engine"]);
  // The grade of ad-1 was made under other question versions, so it is not reused and the ad needs a call.
  await sql`update ad_timelines set jev_question_versions = '["stale@0"]' where research_ad_id = 'ad-1'`;
  await setBrandCaps(sql, { dailyCents: 0, totalCents: 10 });
  const engine = engineWith(TEN_CENTS_PER_CALL);

  assert.equal(await runGrade(sql, engine), "stopped:factory.grade");
  assert.equal(engine.requests.length, 0, "the stale ad's call was refused, and the other ad was reused: no call at all");
  const after = await gradesOf(sql);
  assert.equal(after.find((row) => row.research_ad_id === "ad-1")?.jev_status, "engine", "a cap does not discard the engine grade");
  assert.equal(after.find((row) => row.research_ad_id === "ad-1")?.jev_reason, before.find((row) => row.research_ad_id === "ad-1")?.jev_reason);
  assert.equal((await factoryRunRow(sql)).error, TOTAL_CAP_REASON, "the reason is on the run");
});
