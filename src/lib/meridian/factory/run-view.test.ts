import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
} from "../../../test-support/lib/meridian/testing/factory-fixtures.ts";
import { predictionFingerprint, type GradeRecord } from "./prediction.ts";
import { factoryRunViewsFor } from "./run-view.ts";

// Item 11, the run view: each run's picks with the grade they were made under, and the variants each pick produced, with the attribute
// each variant tests and the creative it became. Every read is tenant-scoped.

const MANUAL = { automation: "manual", decisionEngine: "jev" };
const COLLECT_JOB = "job-research-collect";
const TEMPLATE = `tpl:${FACTORY_TEST_RUN}:ad-1`;

/** The engine grade the pick was made under. No gate record is linked, so the test needs no decision_gate_records row. */
const GRADE: GradeRecord = {
  jev_status: "engine",
  jev_action: "HUMAN_REVIEW",
  jev_reason: "Two questions are uncalibrated.",
  jev_engine_id: "jev",
  jev_model: "fixture-engine-model",
  jev_question_versions: '["market.competitive_strength.v1@1.0.0"]',
  jev_policy_version: "policy@1",
  jev_gate_record_id: null,
};

/** One run with one pick, its storyboard, two variants (the control and one hook change), and one creative for the control. */
async function seedRunWithPick(sql: Sql, options: { pickFingerprint?: string } = {}): Promise<void> {
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedJobRow(sql, COLLECT_JOB, "factory.discover");
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values ('collect-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${COLLECT_JOB}, 'skincare', 'US', 'succeeded', 'user-1')
  `;
  await sql`
    insert into research_ads (id, organization_id, brand_id, collection_run_id, source, external_id, page_id, advertiser, original_url, captured_at)
    values ('ad-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'collect-1', 'meta_ad_library', 'ext-1', 'page-1', 'Rival Co',
      'https://example.com/ad', '2026-10-01T00:00:00.000Z')
  `;
  await sql`
    insert into ad_timelines (
      id, organization_id, brand_id, research_ad_id, first_seen, last_seen, still_running, days_running, winner_score,
      jev_status, jev_action, jev_reason, jev_engine_id, jev_model, jev_question_versions, jev_policy_version, jev_gate_record_id
    ) values (
      'tl:ad-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'ad-1', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', true, 10, 0.8,
      ${GRADE.jev_status}, ${GRADE.jev_action}, ${GRADE.jev_reason}, ${GRADE.jev_engine_id}, ${GRADE.jev_model},
      ${GRADE.jev_question_versions}, ${GRADE.jev_policy_version}, null
    )
  `;
  await sql`
    insert into factory_picks (id, organization_id, brand_id, run_id, concept, research_ad_id, score, method, surface, grade_fingerprint)
    values ('pick:run-factory:0', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, 'ugc / question hook / problem-solution',
      'ad-1', 0.9, 'thompson', 'paid', ${options.pickFingerprint ?? predictionFingerprint(GRADE)})
  `;
  await sql`
    insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard, plan)
    values (${TEMPLATE}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'ad-1', '{}', '{"attributes":{}}')
  `;
  await sql`
    insert into factory_variants (id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result, tests_attribute, angle, format, proof)
    values
      (${`var:${TEMPLATE}:0`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${TEMPLATE}, 'Dry hands?', 'Shop now', '', 15000, 'review', 'control', 'problem-solution', 'demo', 'clinic'),
      (${`var:${TEMPLATE}:1`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${TEMPLATE}, 'Is your skin dry?', 'Shop now', '', 15000, 'review', 'hook', 'problem-solution', 'demo', 'clinic')
  `;
  await sql`
    insert into factory_creatives (organization_id, brand_id, run_id, variant_id, format, creative_id, production_job_id, provider)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, ${`var:${TEMPLATE}:0`}, 'image', 'creative-1', 'job-produce-1', 'test')
  `;
}

test("the run view lists each pick with its prediction and status, and each variant with the attribute it tests and its creative", async () => {
  const sql = await makeFactoryTestSql();
  await seedRunWithPick(sql);

  const views = await factoryRunViewsFor(sql, { organizationId: FACTORY_TEST_ORG, brandId: FACTORY_TEST_BRAND }, [FACTORY_TEST_RUN]);
  const run = views.get(FACTORY_TEST_RUN);
  assert.ok(run, "the run has a view");
  assert.equal(run.picks.length, 1);
  const [pick] = run.picks;
  assert.ok(pick);
  assert.equal(pick.surface, "paid");
  assert.equal(pick.predictionStatus, "same", "the grade is the one the pick was made under");
  assert.equal(pick.prediction.state, "engine");
  if (pick.prediction.state === "engine") {
    assert.equal(pick.prediction.engineId, "jev");
    assert.equal(pick.prediction.action, "HUMAN_REVIEW");
  }
  assert.equal(pick.plan, "planned");
  assert.deepEqual(pick.variants.map((variant) => variant.attribute), ["control", "hook"], "each variant names the attribute it tests");
  assert.deepEqual(pick.variants[0]!.creatives, [{ creativeId: "creative-1", format: "image" }], "the control is the variant that became a creative");
  assert.deepEqual(pick.variants[1]!.creatives, [], "a variant with no creative yet has none");
  assert.equal(pick.variants[1]!.hook, "Is your skin dry?");
});

test("a pick whose ad was graded again shows the change, and a run of another workspace or brand is never returned", async () => {
  const sql = await makeFactoryTestSql();
  await seedRunWithPick(sql);
  await sql`update ad_timelines set jev_engine_id = 'openai-decisions' where research_ad_id = 'ad-1'`;

  const views = await factoryRunViewsFor(sql, { organizationId: FACTORY_TEST_ORG, brandId: FACTORY_TEST_BRAND }, [FACTORY_TEST_RUN]);
  assert.equal(views.get(FACTORY_TEST_RUN)?.picks[0]?.predictionStatus, "regraded");

  const otherWorkspace = await factoryRunViewsFor(sql, { organizationId: "org-other", brandId: FACTORY_TEST_BRAND }, [FACTORY_TEST_RUN]);
  assert.equal(otherWorkspace.get(FACTORY_TEST_RUN)?.picks.length, 0, "another workspace reads none of this run's picks");
  const otherBrand = await factoryRunViewsFor(sql, { organizationId: FACTORY_TEST_ORG, brandId: "brand-other" }, [FACTORY_TEST_RUN]);
  assert.equal(otherBrand.get(FACTORY_TEST_RUN)?.picks.length, 0, "another brand reads none of this run's picks");
});
