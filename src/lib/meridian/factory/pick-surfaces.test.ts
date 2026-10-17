import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { applyLearnedPatternsBySurface } from "../learning/store.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  makeFactoryTestSql,
  seedFactoryRun,
  seedJobRow,
} from "../testing/factory-fixtures.ts";
import { CREATIVE_DNA_VERSION, dnaField, emptyCreativeDna, type AdFormat } from "./creative-dna.ts";
import { learningScopesOf, pickConceptsForRun } from "./pick.ts";

// Item 10, acceptance: an organic win and a paid win each produce a pattern, and both feed the next run's Pick, each only on its own
// surface. The outcomes are seeded so the two surfaces disagree: curiosity wins on organic retention and loses on paid clicks, and
// offer is the reverse. A paid win that moved the organic arm, or an organic win that moved the paid arm, would show here.

const BOTH = { automation: "manual", intent: "both" };
const COLLECT_JOB = "job-research-collect";
const PER_ANGLE = 8;

/** A creative of the brand with one paid outcome and one organic outcome. Revenue follows the same winner, so ROAS agrees. */
async function seedOutcomes(sql: Sql): Promise<void> {
  for (const angle of ["curiosity", "offer"]) {
    const curiosity = angle === "curiosity";
    for (let index = 0; index < PER_ANGLE; index += 1) {
      const id = `cr-${angle}-${index}`;
      await sql`
        insert into creative_records (id, organization_id, brand_id, origin, angle, hook_type, format, cta, created_by)
        values (${id}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'own', ${angle}, 'question', 'ugc', 'shop', 'user-1')
      `;
      await sql`
        insert into performance_observations (
          id, organization_id, brand_id, creative_id, impressions, clicks, conversions, spend_cents, revenue_cents, observed_on, source, created_by
        ) values (
          ${`paid-${id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${id}, 4000, ${curiosity ? 160 : 480}, ${curiosity ? 12 : 40},
          4000, ${curiosity ? 4000 : 12000}, '2026-10-01', 'meta', 'user-1'
        )
      `;
      await sql`
        insert into organic_posts (id, organization_id, brand_id, creative_id, platform, external_id, status)
        values (${`post-${id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${id}, 'instagram', ${`ig-${id}`}, 'published')
      `;
      await sql`
        insert into organic_observations (
          id, organization_id, brand_id, organic_post_id, creative_id, platform, views, three_second_views, completion_rate, shares, observed_on
        ) values (
          ${`organic-${id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${`post-${id}`}, ${id}, 'instagram', 1000,
          ${curiosity ? 600 : 300}, 0.4, ${curiosity ? 60 : 10}, '2026-10-01'
        )
      `;
    }
  }
}

/** Two graded concepts: curiosity and offer, each with a DNA and a timeline. Both are delivering, so both have a draw. */
async function seedConcepts(sql: Sql): Promise<void> {
  await seedJobRow(sql, COLLECT_JOB, "factory.discover");
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values ('collect-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${COLLECT_JOB}, 'skincare', 'US', 'succeeded', 'user-1')
  `;
  for (const [id, angle, winner] of [["ad-curiosity", "curiosity", 0.8], ["ad-offer", "offer", 0.7]] as const) {
    await sql`
      insert into research_ads (id, organization_id, brand_id, collection_run_id, source, external_id, page_id, advertiser, original_url, captured_at)
      values (${id}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'collect-1', 'meta_ad_library', ${`ext-${id}`}, 'page-1',
        'Rival Co', 'https://example.com/ad', '2026-10-01T00:00:00.000Z')
    `;
    const dna = emptyCreativeDna(id, 15000);
    dna.format = dnaField<AdFormat>("ugc", 0.8, { kind: "transcript" });
    dna.hook.type = dnaField("question", 0.8, { kind: "transcript" });
    dna.angle = dnaField(angle, 0.8, { kind: "transcript" });
    await sql`
      insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record)
      values (${`dna:${id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${id}, ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)})
    `;
    await sql`
      insert into ad_timelines (id, organization_id, brand_id, research_ad_id, first_seen, last_seen, still_running, days_running, winner_score)
      values (${`tl:${id}`}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${id}, '2026-09-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z', true, 10, ${winner})
    `;
  }
  // Five of the brain's twenty-five fields have content: enough for the brand-fit question to judge, as in pick.test.ts.
  await sql`
    insert into brand_brains (brand_id, positioning, value_proposition, tone, target_customers, prohibited_claims, updated_by)
    values (${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'Two weeks to brighter skin', 'warm and plain',
      'adults with dry skin', 'cures eczema', 'user-1')
  `;
}

type PatternRow = { attribute: string; value: string; metric: string; surface: string; channel: string };

test("an organic win and a paid win each produce a pattern, and the next both-run's Pick reads each only on its own surface", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: BOTH, level: 0 });
  await seedOutcomes(sql);
  await seedConcepts(sql);

  // The learn stage recomputes the brand's patterns per surface, from the stored outcomes.
  await applyLearnedPatternsBySurface(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND);
  const patterns = await sql<PatternRow>`
    select attribute, value, metric, surface, channel from learned_patterns
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND} and attribute = 'angle' and channel = ''
  `;
  assert.ok(
    patterns.some((row) => row.surface === "organic" && row.value === "curiosity" && row.metric === "retention_3s"),
    "an organic win produces an organic pattern",
  );
  assert.ok(
    patterns.some((row) => row.surface === "paid" && row.value === "offer" && row.metric === "ctr"),
    "a paid win produces a paid pattern",
  );

  // The next run makes creatives for both surfaces, so Pick reads both, each on its own arm of a concept.
  const result = await pickConceptsForRun(sql, {
    organizationId: FACTORY_TEST_ORG,
    brandId: FACTORY_TEST_BRAND,
    runId: FACTORY_TEST_RUN,
    maxPicks: 5,
    learning: learningScopesOf({ intent: "both", platforms: [] }),
  });
  const armOf = (concept: string, surface: string) => {
    const arm = result.weights.find((item) => item.concept.includes(concept) && item.surface === surface);
    assert.ok(arm, `${concept} has an arm on ${surface}`);
    return arm;
  };
  const curiosityOrganic = armOf("curiosity", "organic");
  const curiosityPaid = armOf("curiosity", "paid");
  const offerOrganic = armOf("offer", "organic");
  const offerPaid = armOf("offer", "paid");

  assert.ok(curiosityOrganic.weight > 1, "the organic win raises the organic arm of its concept");
  assert.ok(curiosityPaid.weight < 1, "the paid arm of that concept is moved only by paid patterns, which mark it a loser on paid");
  assert.ok(offerPaid.weight > 1, "the paid win raises the paid arm of its concept");
  assert.ok(offerOrganic.weight < 1, "the organic arm of the paid winner is moved only by organic patterns, which mark it a loser");
  assert.ok(curiosityOrganic.notes.length > 0 && curiosityOrganic.notes.every((note) => note.endsWith("on organic")), "the organic arm names organic patterns only");
  assert.ok(curiosityPaid.notes.length > 0 && curiosityPaid.notes.every((note) => note.endsWith("on paid")), "the paid arm names paid patterns only");
  const proposals = await sql<{ from_surface: string; to_surface: string; value: string }>`
    select from_surface, to_surface, value from factory_surface_proposals
    where organization_id = ${FACTORY_TEST_ORG} and run_id = ${FACTORY_TEST_RUN}
  `;
  assert.ok(proposals.some((row) => row.from_surface === "organic" && row.to_surface === "paid" && row.value === "curiosity"));
  assert.ok(proposals.some((row) => row.from_surface === "paid" && row.to_surface === "organic" && row.value === "offer"));
  assert.ok(curiosityPaid.weight < 1, "the proposal does not raise the paid weight");

  // One pick per concept, each tagged with the surface whose arm drew it, and stored with that surface.
  assert.equal(result.picks.length, 2, "two concepts are graded, so two are picked, once each");
  assert.equal(new Set(result.picks.map((pick) => pick.concept.label)).size, 2);
  assert.ok(result.picks.every((pick) => pick.surface === "organic" || pick.surface === "paid"));
  const stored = await sql<{ concept: string; surface: string; grade_fingerprint: string }>`
    select concept, surface, grade_fingerprint from factory_picks where run_id = ${FACTORY_TEST_RUN} order by id
  `;
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.surface === "organic" || row.surface === "paid"), "each stored pick names its surface");
  assert.ok(stored.every((row) => row.grade_fingerprint === "not-graded"), "an ad with no grade is recorded as not graded");
});

test("a single-surface run learns from its own surface only, and its picks carry that surface", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: { automation: "manual", intent: "organic" }, level: 0 });
  await seedOutcomes(sql);
  await seedConcepts(sql);
  await applyLearnedPatternsBySurface(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND);

  const result = await pickConceptsForRun(sql, {
    organizationId: FACTORY_TEST_ORG,
    brandId: FACTORY_TEST_BRAND,
    runId: FACTORY_TEST_RUN,
    maxPicks: 5,
    learning: learningScopesOf({ intent: "organic", platforms: [] }),
  });
  assert.equal(result.weights.length, 2, "one arm per concept on a single surface");
  assert.ok(result.weights.every((item) => item.surface === "organic"));
  const curiosity = result.weights.find((item) => item.concept.includes("curiosity"));
  assert.ok(curiosity && curiosity.weight > 1, "the organic win moves the organic run");
  const offer = result.weights.find((item) => item.concept.includes("offer"));
  assert.ok(offer && offer.weight < 1, "the organic loss on offer moves the organic run down, and no paid win is applied");
  assert.ok(result.picks.every((pick) => pick.surface === "organic"));
});
