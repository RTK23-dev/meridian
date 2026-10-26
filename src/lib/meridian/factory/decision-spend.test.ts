import { unselectedOpenRouterEngine } from "../testing/openrouter-engine-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import type { DecisionUsage } from "../decisions/types.ts";
import { FixtureDecisionEngine } from "../testing/decision-fixtures.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  factoryJob,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
} from "../testing/factory-fixtures.ts";
import { CREATIVE_DNA_VERSION, dnaField, emptyCreativeDna, type AdFormat } from "./creative-dna.ts";
import { recordDecisionSpend } from "./decision-spend.ts";
import { PRICE_TABLE_VERSION } from "./price-table.ts";
import { meteredSpendOf, runSpendFor } from "./spend.ts";
import { executeFactoryJob, type FactorySeams } from "./worker.ts";

// The engine is named, so a deployment's DECISION_ENGINE value cannot change which fixture is asked.
const OPENAI_RUN = { automation: "manual", decisionEngine: "openai-decisions" };
const COLLECT_JOB = "job-research-collect";
const NOT_CONFIGURED = { status: "NOT_CONFIGURED" as const, message: "No key is saved for this workspace." };

type CostRow = {
  basis: string;
  engine: string;
  model: string;
  cents: number | null;
  micros: number | string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  price_version: string;
  gate_record_id: string;
};

/** One stored competitor ad with its creative DNA. The same seed the grade tests use, so the grade stage has an ad to grade. */
async function seedGradableAd(sql: Sql): Promise<void> {
  await seedJobRow(sql, COLLECT_JOB, "factory.discover");
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values ('collect-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${COLLECT_JOB}, 'skincare', 'US', 'succeeded', 'user-1')
  `;
  await sql`
    insert into research_ads (
      id, organization_id, brand_id, collection_run_id, source, external_id, page_id, advertiser, original_url,
      captured_at, published_at, copy, platforms, source_metrics
    ) values (
      'ad-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'collect-1', 'meta_ad_library', 'ext-1', 'page-1', 'Rival Co',
      'https://example.com/ad', '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      'Dry hands? Try the gentle serum.', '["facebook"]', '{"stoppedAt": null, "countries": ["US"]}'
    )
  `;
  const dna = emptyCreativeDna("ad-1", 15000);
  dna.format = dnaField<AdFormat>("demo", 0.8, { kind: "transcript" });
  dna.hook.type = dnaField("question", 0.8, { kind: "transcript" });
  dna.angle = dnaField("problem-solution", 0.8, { kind: "transcript" });
  await sql`
    insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record)
    values ('dna:ad-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'ad-1', ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)})
  `;
  await sql`
    insert into brand_brains (brand_id, positioning, tone, target_customers, prohibited_claims, updated_by)
    values (${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'warm and plain', 'adults with dry skin', 'cures eczema', 'user-1')
  `;
}

/**
 * An OpenAI Decisions fixture that answers every question, and reports the usage given on each request. The model is the one the
 * answers name, so a priced model and an unpriced one are two fixtures.
 */
function openaiFixture(model: string, usage?: DecisionUsage): FixtureDecisionEngine {
  return new FixtureDecisionEngine({
    id: "openai-decisions",
    model,
    ...(usage ? { usage } : {}),
    respond: (spec) => (spec.type === "choice" ? { choice: "low_risk", confidence: 0.9 } : { probability: 0.99 }),
  });
}

function seamsWith(openai: FixtureDecisionEngine): FactorySeams {
  return {
    decisionEngines: {
      jev: new FixtureDecisionEngine({ health: NOT_CONFIGURED }),
      "openai-decisions": openai,
      "openrouter-decisions": unselectedOpenRouterEngine(),
    },
  };
}

function runGrade(sql: Sql, seams: FactorySeams): Promise<string> {
  return executeFactoryJob(sql, factoryJob("factory.grade"), { runId: FACTORY_TEST_RUN }, undefined, seams);
}

async function tokenRows(sql: Sql): Promise<CostRow[]> {
  return sql<CostRow>`
    select basis, engine, model, cents, micros, prompt_tokens, completion_tokens, price_version, gate_record_id
    from factory_costs where run_id = ${FACTORY_TEST_RUN} and basis = 'tokens'
    order by id
  `;
}

test("a graded decision whose model has no price writes one token row, with its tokens and no cost", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedGradableAd(sql);
  const engine = openaiFixture("gpt-test-unpriced", { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 });

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  const rows = await tokenRows(sql);
  assert.equal(rows.length, 1, "one decision is one row, however many questions it asked");
  const row = rows[0]!;
  assert.equal(row.engine, "openai-decisions");
  assert.equal(row.model, "gpt-test-unpriced");
  assert.equal(row.prompt_tokens, 1000 * engine.requests.length, "the tokens of every engine call the grade made are summed");
  assert.equal(row.completion_tokens, 100 * engine.requests.length);
  assert.equal(row.cents, null, "no price, so no cents");
  assert.equal(row.micros, null, "no price, so no micro-dollars: the cost is unknown, never zero");
  assert.equal(row.price_version, "", "no price table entry was used");
  assert.ok(row.gate_record_id, "the row names the gate record that holds the decision");

  const spend = (await runSpendFor(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND, [FACTORY_TEST_RUN])).get(FACTORY_TEST_RUN);
  assert.equal(spend?.tokenOnlyDecisions, 1, "the run shows one decision as tokens only, not priced");
  assert.equal(spend?.pricedDecisions, 0);
  assert.equal((await meteredSpendOf(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND, FACTORY_TEST_RUN)).totalCents, 0, "caps do not count unpriced spend");
});

test("a graded decision whose model has a published price writes the computed cost, and caps count it", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedGradableAd(sql);
  const engine = openaiFixture("gpt-6-luna", { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 });

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  const rows = await tokenRows(sql);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  const calls = engine.requests.length;
  // Each call is 1,000 input tokens at $0.10 per million (100 micro-dollars) and 100 output tokens at $0.50 per million (50).
  assert.equal(Number(row.micros), 150 * calls, "the cost is the published rate applied to the tokens of every call");
  assert.equal(row.cents, null, "a token row keeps its cost in micro-dollars, not in cents");
  assert.equal(row.price_version, PRICE_TABLE_VERSION, "the row names the price table version it was priced under");
  assert.equal(row.model, "gpt-6-luna");

  const spent = await meteredSpendOf(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND, FACTORY_TEST_RUN);
  assert.equal(spent.totalCents, Math.ceil((150 * calls) / 10_000), "priced spend counts toward the caps, rounded up to a whole cent");
  const spend = (await runSpendFor(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND, [FACTORY_TEST_RUN])).get(FACTORY_TEST_RUN);
  assert.equal(spend?.pricedDecisions, 1);
  assert.equal(spend?.tokenOnlyDecisions, 0);
});

test("a rerun of a graded ad that the engine already graded writes no new row and asks the engine nothing", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedGradableAd(sql);
  const engine = openaiFixture("gpt-6-luna", { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 });

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  const callsAfterFirst = engine.requests.length;
  const rowsAfterFirst = await tokenRows(sql);
  assert.equal(rowsAfterFirst.length, 1);

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  assert.equal(engine.requests.length, callsAfterFirst, "the grade is kept, so the engine is not asked again");
  assert.deepEqual(await tokenRows(sql), rowsAfterFirst, "the rerun adds no row");
});

test("an engine that reports no usage, such as JEV, writes no token row", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  await seedGradableAd(sql);
  const engine = openaiFixture("gpt-6-luna");

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  assert.ok(engine.requests.length > 0, "the engine was called");
  assert.equal((await tokenRows(sql)).length, 0, "no usage was reported, so no tokens are metered and nothing is invented");
});

test("a decision is written once: recording the same gate record again adds nothing, and a decision that spent no tokens writes nothing", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  const decision = {
    organizationId: FACTORY_TEST_ORG,
    brandId: FACTORY_TEST_BRAND,
    runId: FACTORY_TEST_RUN,
    stage: "factory.produce",
    gateRecordId: "gate-record-1",
    engineCalled: true,
    engineId: "openai-decisions",
    requestedModel: "gpt-6-luna",
    returnedModel: "gpt-6-luna-2026-09-22",
    usage: { inputTokens: 2000, outputTokens: 200 },
  };
  assert.equal(await recordDecisionSpend(sql, decision), "recorded");
  assert.equal(await recordDecisionSpend(sql, decision), "already-recorded", "the same decision is not counted twice");
  const rows = await tokenRows(sql);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0]!.micros), 300, "a dated snapshot of the priced model is priced under it: 2,000 at $0.10 plus 200 at $0.50");
  assert.equal(rows[0]!.model, "gpt-6-luna-2026-09-22", "the row names the model the provider reported");

  const nothing = await recordDecisionSpend(sql, { ...decision, gateRecordId: "gate-record-2", engineCalled: false });
  assert.equal(nothing, "not-metered", "a decision that called no engine spent nothing");
  assert.equal(await recordDecisionSpend(sql, { ...decision, gateRecordId: "gate-record-3", usage: undefined }), "not-metered");
  assert.equal((await tokenRows(sql)).length, 1);
});

test("caps count priced cost from both kinds of row, and leave out an unpriced token row", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: OPENAI_RUN, level: 0 });
  // A provider call that reported 3 cents, a priced decision of 25,000 micro-dollars (two and a half cents), and an unpriced decision.
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, micros)
    values ('cost-provider', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, 'factory.produce', 3, 0,
      'google_nano_banana', null, 'provider_reported', null)
  `;
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, micros, engine, model)
    values ('cost-priced', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, 'factory.grade', null, 0,
      'openai-decisions', null, 'tokens', 25000, 'openai-decisions', 'gpt-6-luna')
  `;
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, micros, engine, model)
    values ('cost-unpriced', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, 'factory.grade', null, 0,
      'openai-decisions', null, 'tokens', null, 'openai-decisions', 'gpt-test-unpriced')
  `;
  // 30,000 + 25,000 micro-dollars is 5.5 cents, which rounds up to 6 for the caps.
  assert.equal((await meteredSpendOf(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND, FACTORY_TEST_RUN)).totalCents, 6);
});
