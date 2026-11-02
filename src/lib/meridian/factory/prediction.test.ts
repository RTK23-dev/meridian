import { unselectedOpenRouterEngine } from "../../../test-support/lib/meridian/testing/openrouter-engine-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { FixtureDecisionEngine } from "../../../test-support/lib/meridian/testing/decision-fixtures.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  factoryJob,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
} from "../../../test-support/lib/meridian/testing/factory-fixtures.ts";
import { CREATIVE_DNA_VERSION, dnaField, emptyCreativeDna, type AdFormat } from "./creative-dna.ts";
import { gradingQuestionVersions, NO_ENGINE_GRADE } from "./grade.ts";
import { learningScopesOf, pickConceptsForRun } from "./pick.ts";
import {
  NOT_GRADED,
  OBSERVED_ONLY,
  predictionFingerprint,
  predictionOf,
  predictionStatusOf,
  type GradeRecord,
} from "./prediction.ts";
import { executeFactoryJob, type FactorySeams } from "./worker.ts";

// Item 10 (JEV predictions stored next to outcomes) and item 11 (the run view). A pick stores the fingerprint of the grade its ad
// carried. The grade itself stays in ad_timelines, so the pick is a link, not a second copy.

const ENGINE_GRADE: GradeRecord = {
  jev_status: "engine",
  jev_action: "HUMAN_REVIEW",
  jev_reason: "Two questions are uncalibrated, so the item goes to review.",
  jev_engine_id: "jev",
  jev_model: "fixture-engine-model",
  jev_question_versions: '["market.competitive_strength.v1@1.0.0"]',
  jev_policy_version: "policy@1",
  jev_gate_record_id: "gate-1",
};

test("an ad with no stored grade, or one graded on observed signal only, has a fingerprint that says so", () => {
  assert.equal(predictionFingerprint(null), NOT_GRADED);
  assert.equal(predictionFingerprint({ ...ENGINE_GRADE, jev_status: null }), NOT_GRADED);
  assert.equal(predictionFingerprint({ ...ENGINE_GRADE, jev_status: "observed_only" }), OBSERVED_ONLY);
});

test("an engine grade's fingerprint is stable, and changes when the engine, model, questions, policy, answer or gate record changes", () => {
  const fingerprint = predictionFingerprint(ENGINE_GRADE);
  assert.match(fingerprint, /^engine:[0-9a-f]{32}$/);
  assert.equal(predictionFingerprint({ ...ENGINE_GRADE }), fingerprint);
  const changes: Array<Partial<GradeRecord>> = [
    { jev_engine_id: "openai-decisions" },
    { jev_model: "another-model" },
    { jev_question_versions: '["market.competitive_strength.v2@1.0.0"]' },
    { jev_policy_version: "policy@2" },
    { jev_action: "REJECT" },
    { jev_gate_record_id: "gate-2" },
  ];
  for (const change of changes) {
    assert.notEqual(predictionFingerprint({ ...ENGINE_GRADE, ...change }), fingerprint, `a changed ${Object.keys(change)[0]} changes the fingerprint`);
  }
});

test("the prediction a pick was made under is read as same, regraded, or unrecorded", () => {
  const stored = predictionFingerprint(ENGINE_GRADE);
  assert.equal(predictionStatusOf("", ENGINE_GRADE), "unrecorded", "a pick written before fingerprints has no known prediction");
  assert.equal(predictionStatusOf(stored, ENGINE_GRADE), "same");
  assert.equal(predictionStatusOf(stored, { ...ENGINE_GRADE, jev_engine_id: "openai-decisions" }), "regraded");
});

test("a grade reads as the engine's answer or as not graded, and a missing engine is never shown as a score", () => {
  assert.deepEqual(predictionOf(null), { state: "not_graded" });
  assert.deepEqual(predictionOf({ ...ENGINE_GRADE, jev_status: null }), { state: "not_graded" });
  assert.deepEqual(
    predictionOf({ ...ENGINE_GRADE, jev_status: "observed_only", jev_reason: NO_ENGINE_GRADE }),
    { state: "observed_only", reason: NO_ENGINE_GRADE },
  );
  const engine = predictionOf(ENGINE_GRADE);
  if (engine.state !== "engine") assert.fail("an engine grade reads as an engine answer");
  assert.equal(engine.action, "HUMAN_REVIEW");
  assert.equal(engine.engineId, "jev");
  assert.equal(engine.model, "fixture-engine-model");
  assert.deepEqual(engine.questionVersions, ["market.competitive_strength.v1@1.0.0"]);
  const unreadable = predictionOf({ ...ENGINE_GRADE, jev_question_versions: "not json" });
  if (unreadable.state !== "engine") assert.fail("an unreadable version list keeps the engine answer");
  assert.deepEqual(unreadable.questionVersions, [], "an unreadable version list is empty, never guessed");
});

// ---------------------------------------------------------------------------------------------------------------------------
// On the database with every migration applied, graded by the fixture engines (no live key).
// ---------------------------------------------------------------------------------------------------------------------------

const MANUAL = { automation: "manual", decisionEngine: "jev" };
const COLLECT_JOB = "job-research-collect";
const NOT_CONFIGURED = { status: "NOT_CONFIGURED" as const, message: "No TypeSafe key is saved for this workspace." };

/** One stored competitor ad with its creative DNA, and five of the brain's fields, enough for the brand-fit question to judge. */
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
    insert into brand_brains (brand_id, positioning, value_proposition, tone, target_customers, prohibited_claims, updated_by)
    values (${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'Two weeks to brighter skin', 'warm and plain',
      'adults with dry skin', 'cures eczema', 'user-1')
  `;
}

/** A grade engine that answers every question, as in grade-jev.test.ts. */
function readyEngine(id: "jev" | "openai-decisions" = "jev"): FixtureDecisionEngine {
  return new FixtureDecisionEngine({
    id,
    respond: (spec) => (spec.type === "choice" ? { choice: "low_risk", confidence: 0.9 } : { probability: 0.99 }),
  });
}

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

async function runPick(sql: Sql): Promise<number> {
  const picked = await pickConceptsForRun(sql, {
    organizationId: FACTORY_TEST_ORG,
    brandId: FACTORY_TEST_BRAND,
    runId: FACTORY_TEST_RUN,
    maxPicks: 3,
    learning: learningScopesOf({ intent: "organic", platforms: [] }),
  });
  return picked.picks.length;
}

type GradeRow = GradeRecord & { winner_score: number | null };

async function gradeOf(sql: Sql): Promise<GradeRow> {
  const rows = await sql<GradeRow>`
    select winner_score, jev_status, jev_action, jev_reason, jev_engine_id, jev_model, jev_question_versions,
      jev_policy_version, jev_gate_record_id
    from ad_timelines where research_ad_id = 'ad-1'
  `;
  if (!rows[0]) throw new Error("The graded ad has no timeline row.");
  return rows[0];
}

async function storedFingerprint(sql: Sql): Promise<string> {
  const rows = await sql<{ grade_fingerprint: string }>`select grade_fingerprint from factory_picks where run_id = ${FACTORY_TEST_RUN}`;
  assert.equal(rows.length, 1, "the run holds one pick");
  return rows[0]!.grade_fingerprint;
}

test("a pick stores the grade its ad carried, and the grade is shown as the prediction it was made under until the ad is graded again", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql);

  assert.equal(await runGrade(sql, seamsWith(readyEngine())), "graded:1");
  const graded = await gradeOf(sql);
  assert.equal(graded.jev_status, "engine");
  assert.deepEqual(predictionOf(graded), {
    state: "engine",
    action: graded.jev_action,
    engineId: "jev",
    model: "fixture-engine-model",
    questionVersions: gradingQuestionVersions(),
    reason: graded.jev_reason,
  });

  assert.equal(await runPick(sql), 1);
  const stored = await storedFingerprint(sql);
  assert.equal(stored, predictionFingerprint(graded), "the pick holds the fingerprint of the grade its ad carried");
  assert.equal(predictionStatusOf(stored, graded), "same");

  // The ad is graded again, by another engine, after the pick. The current grade changes. The earlier grade is kept.
  await sql`update factory_runs set settings = ${JSON.stringify({ ...MANUAL, decisionEngine: "openai-decisions" })} where id = ${FACTORY_TEST_RUN}`;
  assert.equal(await runGrade(sql, seamsWith(readyEngine(), readyEngine("openai-decisions"))), "graded:1");
  const regraded = await gradeOf(sql);
  assert.equal(regraded.jev_engine_id, "openai-decisions");
  assert.equal(predictionStatusOf(stored, regraded), "regraded");
  assert.equal(await storedFingerprint(sql), stored, "the pick is not rewritten by a later grade");
  const history = await sql<{ jev_engine_id: string | null }>`
    select jev_engine_id from ad_timeline_grades
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND} and research_ad_id = 'ad-1'
  `;
  assert.equal(history.length, 1, "the grade the pick was made under is kept");
  assert.equal(history[0]?.jev_engine_id, "jev");
});

test("with no decision engine ready, the pick is recorded as observed only, and its prediction reads not graded, never as a score", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradableAd(sql);

  const notReady: FactorySeams = {
    decisionEngines: {
      jev: new FixtureDecisionEngine({ id: "jev", health: NOT_CONFIGURED }),
      "openai-decisions": new FixtureDecisionEngine({ id: "openai-decisions", health: NOT_CONFIGURED }),
      "openrouter-decisions": unselectedOpenRouterEngine(),
    },
  };
  assert.equal(await runGrade(sql, notReady), "graded:1");
  const graded = await gradeOf(sql);
  assert.equal(graded.jev_status, "observed_only");
  assert.equal(graded.jev_reason, NO_ENGINE_GRADE);

  assert.equal(await runPick(sql), 1);
  assert.equal(await storedFingerprint(sql), OBSERVED_ONLY);
  assert.deepEqual(predictionOf(graded), { state: "observed_only", reason: NO_ENGINE_GRADE });
});
