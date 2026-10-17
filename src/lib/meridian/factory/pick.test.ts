import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_FIELDS, type BrainKey } from "../brain.ts";
import type { Sql } from "../learning/store.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  factoryJob,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
} from "../testing/factory-fixtures.ts";
import { CREATIVE_DNA_VERSION, dnaField, emptyCreativeDna, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import { brandFitOf, conceptOf, learnedWeightOf, type LearnedRow } from "./pick.ts";
import { executeFactoryJob } from "./worker.ts";

const MANUAL = { automation: "manual" };
const COLLECT_JOB = "job-research-collect";

function brainWith(overrides: Partial<Record<BrainKey, string>> = {}): Record<BrainKey, string> {
  const values = Object.fromEntries(BRAIN_FIELDS.map((field) => [field.key, ""])) as Record<BrainKey, string>;
  return { ...values, positioning: "Gentle daily serums for dry skin", tone: "warm and plain", targetCustomers: "adults with dry skin", ...overrides };
}

function dnaFor(adId: string, format: AdFormat, hookType: string, angle: string): CreativeDna {
  const dna = emptyCreativeDna(adId, 15000);
  dna.format = dnaField<AdFormat>(format, 0.8, { kind: "transcript" });
  dna.hook.type = dnaField(hookType, 0.8, { kind: "transcript" });
  dna.angle = dnaField(angle, 0.8, { kind: "transcript" });
  return dna;
}

const LEARNED_WIN: LearnedRow = {
  attribute: "angle",
  value: "problem-solution",
  metric: "ctr",
  lift: 0.5,
  sample_size: 10,
  impressions: 5000,
  state: "VALIDATED",
  p_beat: 0.9,
  ci_low: 0.1,
  ci_high: 0.9,
  surface: "paid",
  channel: "",
};

/** A paid run that names no platform: it reads paid patterns on every channel. */
const PAID_RUN = { surface: "paid" as const, platforms: [] as string[] };

test("a concept is filtered out when the brain is too thin to confirm its fit", () => {
  const concept = conceptOf(dnaFor("ad-1", "demo", "question", "problem-solution"));
  assert.ok(concept);
  const reading = brandFitOf(concept, brainWith(), 0.02);
  assert.equal(reading.passes, false);
  assert.match(reading.reason, /too thin/);
});

test("a concept that uses a word the brand avoids is filtered out, and a concept without one passes", () => {
  const avoiding = conceptOf(dnaFor("ad-2", "demo", "question", "cheap alternative"));
  assert.ok(avoiding);
  const blocked = brandFitOf(avoiding, brainWith({ wordsToAvoid: "cheap" }), 0.6);
  assert.equal(blocked.passes, false);
  assert.match(blocked.reason, /brand avoids: cheap/);

  const fine = conceptOf(dnaFor("ad-3", "demo", "question", "problem-solution"));
  assert.ok(fine);
  assert.equal(brandFitOf(fine, brainWith({ wordsToAvoid: "cheap" }), 0.6).passes, true);
});

test("a learned win on the concept's angle raises its weight, and a learned loss lowers it", () => {
  const concept = conceptOf(dnaFor("ad-4", "demo", "question", "problem-solution"));
  assert.ok(concept);
  const winner = learnedWeightOf(concept, [LEARNED_WIN], PAID_RUN);
  assert.ok(winner.weight > 1, `a learned win raises the weight to ${winner.weight}`);
  assert.ok(winner.notes.some((note) => /learned to win/.test(note)));

  const loser = learnedWeightOf(concept, [
    { ...LEARNED_WIN, lift: -0.4, p_beat: 0.1, ci_low: -0.6, ci_high: -0.2, state: "INFERRED" },
  ], PAID_RUN);
  assert.ok(loser.weight < 1, `a learned loss lowers the weight to ${loser.weight}`);
  assert.ok(loser.weight >= 0.1, "a learned loss never removes the concept outright");
});

test("a low 3 second retention measurement is ignored, and another metric is not compared to that floor", () => {
  const concept = conceptOf(dnaFor("ad-retention", "demo", "question", "problem-solution"));
  assert.ok(concept);
  const low = learnedWeightOf(concept, [{ ...LEARNED_WIN, metric: "retention_3s", observed: 0.2 }], PAID_RUN, null, 0.45);
  assert.equal(low.weight, 1);
  const clicks = learnedWeightOf(concept, [{ ...LEARNED_WIN, observed: 0.01 }], PAID_RUN, null, 0.45);
  assert.ok(clicks.weight > 1);
});

test("a pattern on another value, or on no attribute the concept has, leaves the weight at one", () => {
  const concept = conceptOf(dnaFor("ad-5", "demo", "question", "problem-solution"));
  assert.ok(concept);
  assert.equal(learnedWeightOf(concept, [{ ...LEARNED_WIN, value: "social-proof" }], PAID_RUN).weight, 1);
  assert.equal(learnedWeightOf(concept, [{ ...LEARNED_WIN, attribute: "offer" }], PAID_RUN).weight, 1);
});

test("a DNA with no angle is not a concept, because a concept needs an angle", () => {
  const dna = dnaFor("ad-6", "demo", "question", "");
  assert.equal(conceptOf(dna), null);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The stage, on the database with every migration applied.
// ---------------------------------------------------------------------------------------------------------------------------

type GradedAd = { id: string; dna: CreativeDna; winner: number; stillRunning: boolean | null };

const GRADED_ADS: GradedAd[] = [
  { id: "ad-a1", dna: dnaFor("ad-a1", "demo", "question", "problem-solution"), winner: 0.8, stillRunning: true },
  { id: "ad-a2", dna: dnaFor("ad-a2", "demo", "question", "problem-solution"), winner: 0.7, stillRunning: true },
  { id: "ad-a3", dna: dnaFor("ad-a3", "demo", "question", "problem-solution"), winner: 0.6, stillRunning: null },
  { id: "ad-b1", dna: dnaFor("ad-b1", "ugc", "pattern interrupt", "social-proof"), winner: 0.3, stillRunning: false },
];

async function seedGradedAds(sql: Sql): Promise<void> {
  await seedJobRow(sql, COLLECT_JOB, "factory.discover");
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values ('collect-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${COLLECT_JOB}, 'skincare', 'US', 'succeeded', 'user-1')
  `;
  for (const ad of GRADED_ADS) {
    await sql`
      insert into research_ads (id, organization_id, brand_id, collection_run_id, source, external_id, page_id, advertiser, original_url, captured_at)
      values (${ad.id}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'collect-1', 'meta_ad_library', ${`ext-${ad.id}`}, 'page-1',
        'Rival Co', 'https://example.com/ad', '2026-10-01T00:00:00.000Z')
    `;
    await sql`
      insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record)
      values (${`dna:${ad.id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${ad.id}, ${CREATIVE_DNA_VERSION}, ${JSON.stringify(ad.dna)})
    `;
    await sql`
      insert into ad_timelines (id, organization_id, brand_id, research_ad_id, first_seen, last_seen, still_running, days_running, winner_score)
      values (${`tl:${ad.id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${ad.id}, '2026-09-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z', ${ad.stillRunning}, 10, ${ad.winner})
    `;
  }
  // Five of the brain's twenty-five fields have content: enough for the brand-fit question to judge.
  await sql`
    insert into brand_brains (brand_id, positioning, value_proposition, tone, target_customers, prohibited_claims, updated_by)
    values (${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'Two weeks to brighter skin', 'warm and plain',
      'adults with dry skin', 'cures eczema', 'user-1')
  `;
}

type PickRow = { concept: string; research_ad_id: string; score: number; method: string; organization_id: string; brand_id: string };

async function pickRows(sql: Sql): Promise<PickRow[]> {
  return sql<PickRow>`
    select concept, research_ad_id, score, method, organization_id, brand_id from factory_picks
    where run_id = ${FACTORY_TEST_RUN} order by id
  `;
}

test("the pick stage stores one pick per graded concept, with its method, and the same run draws the same picks", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedGradedAds(sql);

  assert.equal(await executeFactoryJob(sql, factoryJob("factory.pick"), { runId: FACTORY_TEST_RUN }), "picked:2");
  const rows = await pickRows(sql);
  assert.equal(rows.length, 2, "two concepts are graded, so two are picked");
  for (const row of rows) {
    assert.equal(row.method, "thompson");
    assert.equal(row.organization_id, FACTORY_TEST_ORG);
    assert.equal(row.brand_id, FACTORY_TEST_BRAND);
    assert.ok(row.score > 0, "a pick has a positive score");
  }
  const angles = rows.map((row) => row.concept);
  assert.ok(angles.some((label) => label.includes("problem-solution")), "the proven concept is picked");
  assert.ok(angles.some((label) => label.includes("social-proof")), "the untested concept is picked too");
  const storyboarded = rows.find((row) => row.concept.includes("problem-solution"));
  assert.equal(storyboarded?.research_ad_id, "ad-a1", "the concept is storyboarded from its highest observed winner");

  await executeFactoryJob(sql, factoryJob("factory.pick"), { runId: FACTORY_TEST_RUN });
  assert.deepEqual(await pickRows(sql), rows, "a rerun of the same run replaces the picks with the same ones");
});
