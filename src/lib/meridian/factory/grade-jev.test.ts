import { unselectedOpenRouterEngine } from "../testing/openrouter-engine-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
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
import { gradingQuestionVersions, NO_DNA_GRADE, NO_ENGINE_GRADE } from "./grade.ts";
import { executeFactoryJob, type FactorySeams } from "./worker.ts";

// The engine is named, so a deployment's DECISION_ENGINE value cannot change which fixture is asked.
const MANUAL = { automation: "manual", decisionEngine: "jev" };
const COLLECT_JOB = "job-research-collect";
const NOT_CONFIGURED = { status: "NOT_CONFIGURED" as const, message: "No TypeSafe key is saved for this workspace." };

type TimelineRow = {
  winner_score: number | null;
  jev_status: string | null;
  jev_action: string | null;
  jev_reason: string;
  jev_engine_id: string | null;
  jev_model: string | null;
  jev_question_versions: string;
  jev_policy_version: string;
  jev_gate_record_id: string | null;
  jev_votes: string;
  graded_by_run_id: string | null;
};

type Vote = { question: string; outcome: string; calibrationStatus: string };

/** One stored competitor ad with its creative DNA and the brand's brain. The ad copy is stored, so the risk question has its evidence. */
async function seedGradableAd(sql: Sql, options: { dna?: boolean } = {}): Promise<void> {
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
  if (options.dna !== false) {
    // The DNA holds the structure of the ad: its format, hook type and angle. Its lines are not stored.
    const dna = emptyCreativeDna("ad-1", 15000);
    dna.format = dnaField<AdFormat>("demo", 0.8, { kind: "transcript" });
    dna.hook.type = dnaField("question", 0.8, { kind: "transcript" });
    dna.angle = dnaField("problem-solution", 0.8, { kind: "transcript" });
    await sql`
      insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record)
      values ('dna:ad-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'ad-1', ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)})
    `;
  }
  await sql`
    insert into brand_brains (brand_id, positioning, tone, target_customers, prohibited_claims, updated_by)
    values (${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'warm and plain', 'adults with dry skin', 'cures eczema', 'user-1')
  `;
}

async function timelineRow(sql: Sql): Promise<TimelineRow> {
  const rows = await sql<TimelineRow>`
    select winner_score, jev_status, jev_action, jev_reason, jev_engine_id, jev_model, jev_question_versions,
      jev_policy_version, jev_gate_record_id, jev_votes, graded_by_run_id
    from ad_timelines where research_ad_id = 'ad-1'
  `;
  if (!rows[0]) throw new Error("The graded ad has no timeline row.");
  return rows[0];
}

function votesOf(row: TimelineRow): Vote[] {
  return JSON.parse(row.jev_votes) as Vote[];
}

/** A grade engine that answers every question: a probability for the predicates, and a low risk for the choice. */
function readyEngine(options: { calibrationStatus?: "calibrated" | "uncalibrated"; id?: "jev" | "openai-decisions" } = {}): FixtureDecisionEngine {
  return new FixtureDecisionEngine({
    id: options.id ?? "jev",
    calibrationStatus: options.calibrationStatus,
    respond: (spec) => (spec.type === "choice" ? { choice: "low_risk", confidence: 0.9 } : { probability: 0.99 }),
  });
}

/** The engines a grade may call. The engine the test does not use reports not configured, so it is never asked. */
function seamsWith(jev: FixtureDecisionEngine, openai?: FixtureDecisionEngine): FactorySeams {
  return {
    decisionEngines: {
      jev,
      "openai-decisions": openai ?? new FixtureDecisionEngine({ id: "openai-decisions", health: NOT_CONFIGURED }),
      "openrouter-decisions": unselectedOpenRouterEngine(),
    },
  };
}

async function runGrade(sql: Sql, seams: FactorySeams): Promise<string> {
  return executeFactoryJob(sql, factoryJob("factory.grade"), { runId: FACTORY_TEST_RUN }, undefined, seams);
}

test("with a fixture engine ready, the grade is stored beside the observed score, with its engine, model and question versions", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql);
  const engine = readyEngine();

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  const row = await timelineRow(sql);
  assert.equal(row.jev_status, "engine");
  assert.equal(row.jev_engine_id, "jev");
  assert.equal(row.jev_model, "fixture-engine-model");
  assert.deepEqual(JSON.parse(row.jev_question_versions), gradingQuestionVersions(), "each grade records the question versions it was asked under");
  assert.ok(row.jev_policy_version.includes("market.competitive_strength.v1@1.0.0"));
  assert.ok(row.jev_gate_record_id, "the gate record that holds the full decision is linked");
  assert.equal(row.graded_by_run_id, FACTORY_TEST_RUN);
  assert.equal(typeof row.winner_score, "number", "the observed signal is still stored, not replaced");
  assert.equal(engine.requests.length, 5, "each grading question has its own evidence scope, so each is one engine call");
  const asked = new Set(votesOf(row).map((vote) => vote.question));
  for (const question of ["competitive_strength", "reproducibility", "brand_fit", "positioning_fit", "risk_safety"]) {
    assert.ok(asked.has(question), `${question} is part of the grade`);
  }
});

test("with no decision engine configured, the item is graded on observed signal only, and the grade says so", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql);
  const engine = new FixtureDecisionEngine({ health: NOT_CONFIGURED });

  assert.equal(await runGrade(sql, seamsWith(engine)), "graded:1");
  const row = await timelineRow(sql);
  assert.equal(row.jev_status, "observed_only");
  assert.equal(row.jev_reason, "graded on observed signal only: no decision engine configured");
  assert.equal(row.jev_reason, NO_ENGINE_GRADE);
  assert.equal(row.jev_action, null, "no engine decision is recorded");
  assert.equal(row.jev_engine_id, null);
  assert.equal(row.jev_gate_record_id, null);
  assert.equal(engine.requests.length, 0, "no engine is called when none is configured");
  assert.equal(typeof row.winner_score, "number", "the observed signal is stored");
  assert.doesNotMatch(row.jev_reason, /pass/i, "an observed-only grade never reads as a pass");
});

test("an uncalibrated threshold routes the grade to review, even when the engine reports a calibrated, confident probability", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql);

  await runGrade(sql, seamsWith(readyEngine({ calibrationStatus: "calibrated" })));
  const row = await timelineRow(sql);
  assert.equal(row.jev_action, "HUMAN_REVIEW", "no uncalibrated threshold can approve or reject the item");
  const votes = votesOf(row);
  for (const question of ["competitive_strength", "reproducibility"]) {
    const vote = votes.find((entry) => entry.question === question);
    assert.ok(vote, `${question} has a vote`);
    assert.equal(vote.outcome, "HUMAN_REVIEW", `${question} routes to review`);
    assert.equal(vote.calibrationStatus, "uncalibrated", `${question} is judged uncalibrated`);
  }
});

test("a run's own engine choice grades with that engine, and the grade records it", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: { automation: "manual", decisionEngine: "openai-decisions" }, level: 0 });
  await seedGradableAd(sql);
  const jev = readyEngine();
  const openai = readyEngine({ id: "openai-decisions" });

  await runGrade(sql, seamsWith(jev, openai));
  const row = await timelineRow(sql);
  assert.equal(row.jev_engine_id, "openai-decisions");
  assert.equal(jev.requests.length, 0, "the workspace's other engine is never called for this run");
  assert.equal(openai.requests.length, 5);
});

test("an item the same engine graded with the same questions is not asked again", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql);
  const engine = readyEngine();

  await runGrade(sql, seamsWith(engine));
  const first = await timelineRow(sql);
  await runGrade(sql, seamsWith(engine));
  const second = await timelineRow(sql);
  assert.equal(engine.requests.length, 5, "the second run spends no engine call on the item");
  assert.equal(second.jev_gate_record_id, first.jev_gate_record_id, "the first grade is kept");
  assert.equal(second.jev_action, first.jev_action);
});

test("an ad with no stored creative DNA has no concept to put to an engine, so it is graded on observed signal only", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql, { dna: false });
  const engine = readyEngine();

  await runGrade(sql, seamsWith(engine));
  const row = await timelineRow(sql);
  assert.equal(row.jev_status, "observed_only");
  assert.equal(row.jev_reason, NO_DNA_GRADE);
  assert.equal(engine.requests.length, 0);
});
