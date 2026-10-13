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
import { parseStoredPlan } from "./plan.ts";
import { executeFactoryJob, type FactorySeams } from "./worker.ts";

const COLLECT_JOB = "job-research-collect";
const NOT_CONFIGURED = { status: "NOT_CONFIGURED" as const, message: "No key is saved for this workspace." };

/** A run that makes video in every stage, with a spend cap set, so produce runs without an approval the test cannot give. */
const FULL_WITH_CAP = { automation: "full", caps: { dailyCents: 0, totalCents: 1000, maxVariants: 8 } };

type VariantRow = {
  hook: string;
  cta: string;
  presenter: string;
  length_ms: number;
  angle: string;
  format: string;
  proof: string;
  tests_attribute: string;
};

const COMPARED = ["hook", "cta", "presenter", "length_ms", "angle", "format", "proof"] as const;

/** One graded ad, its creative DNA, and the brand's brain and product. The DNA holds the ad's framework, and its hook text is the
 * competitor's own words, which the plan must never carry into a variant. */
async function seedPlannableAd(sql: Sql): Promise<void> {
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
      'Ever wondered why your hands crack every winter?', '["facebook"]', '{"stoppedAt": null, "countries": ["US"]}'
    )
  `;
  const dna = emptyCreativeDna("ad-1", 15000);
  dna.format = dnaField<AdFormat>("demo", 0.8, { kind: "transcript" });
  dna.hook.type = dnaField("question", 0.8, { kind: "transcript" });
  dna.hook.text = dnaField("Ever wondered why your hands crack every winter?", 0.8, { kind: "transcript" });
  dna.angle = dnaField("problem-solution", 0.8, { kind: "transcript" });
  await sql`
    insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record)
    values ('dna:ad-1', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 'ad-1', ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)})
  `;
  await sql`
    insert into brand_brains (
      brand_id, positioning, value_proposition, tone, target_customers, prohibited_claims, problems, differentiators,
      proof_points, offers, preferred_formats, updated_by
    ) values (
      ${FACTORY_TEST_BRAND}, 'Gentle daily serums for dry skin', 'Two weeks to brighter skin', 'warm and plain',
      'adults with dry skin', 'cures eczema', 'Dry hands by 3pm', 'Fragrance-free in one drop', 'Dermatologist tested',
      'Free shipping on first order', 'UGC, demo', 'user-1'
    )
  `;
  await sql`
    insert into products (id, brand_id, name, created_by) values ('product-1', ${FACTORY_TEST_BRAND}, 'Glow Serum', 'user-1')
  `;
}

test("the grade, pick, template and produce stages plan one pick, and every variant changes exactly one attribute against its control", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  await seedPlannableAd(sql);
  const engine = new FixtureDecisionEngine({ respond: (spec) => (spec.type === "choice" ? { choice: "low_risk" } : { probability: 0.99 }) });
  const seams: FactorySeams = {
    decisionEngines: { jev: engine, "openai-decisions": new FixtureDecisionEngine({ id: "openai-decisions", health: NOT_CONFIGURED }) },
  };
  const payload = { runId: FACTORY_TEST_RUN };

  assert.equal(await executeFactoryJob(sql, factoryJob("factory.grade"), payload, undefined, seams), "graded:1");
  assert.equal(await executeFactoryJob(sql, factoryJob("factory.pick"), payload), "picked:1");
  assert.equal(await executeFactoryJob(sql, factoryJob("factory.template"), payload), "templates:1;plans:1;refused:0");

  const [template] = await sql<{ plan: string; gate: string | null }>`
    select t.plan, tl.jev_gate_record_id as gate from factory_templates t
    join ad_timelines tl on tl.research_ad_id = t.source_ad_id and tl.organization_id = t.organization_id and tl.brand_id = t.brand_id
    where t.id = ${`tpl:${FACTORY_TEST_RUN}:ad-1`}
  `;
  assert.ok(template, "the pick has a template");
  const stored = parseStoredPlan(template.plan);
  assert.ok(stored, "the pick has a stored CreativePlan");
  assert.equal(stored.creativePlan.lineage.decisionId, template.gate, "the plan is made under the grade's engine decision");
  assert.equal(stored.creativePlan.productionContext?.productName, "Glow Serum");

  assert.equal(await executeFactoryJob(sql, factoryJob("factory.produce"), payload), "variants:6");
  const rows = await sql<VariantRow>`
    select hook, cta, presenter, length_ms, angle, format, proof, tests_attribute from factory_variants
    where template_id = ${`tpl:${FACTORY_TEST_RUN}:ad-1`} order by id
  `;
  assert.equal(rows.length, 6, "the control and one variant for each of the five attributes the brain supplies");

  const control = rows.filter((row) => row.tests_attribute === "control");
  assert.equal(control.length, 1, "one row is the control");
  const base = control[0];
  assert.ok(base);
  assert.equal(base.hook, "question", "the control's hook is the winning ad's framework, not its words");
  assert.equal(base.cta, "", "the control carries no call to action the brain did not supply");

  const variants = rows.filter((row) => row.tests_attribute !== "control");
  assert.deepEqual(
    variants.map((row) => row.tests_attribute).sort(),
    ["angle", "cta", "format", "hook", "proof"],
    "each variant records the attribute it tests",
  );
  for (const row of variants) {
    const differing = COMPARED.filter((column) => row[column] !== base[column]);
    assert.deepEqual(differing, [row.tests_attribute], `a ${row.tests_attribute} variant changes only that attribute`);
  }
  assert.ok(rows.every((row) => row.cta !== "shop" && row.cta !== "learn"), "the fixed CTA list is gone");
  assert.ok(rows.every((row) => row.presenter === ""), "no presenter is invented: the DNA names none");
  assert.ok(rows.every((row) => row.hook !== "pattern interrupt"), "the fixed hook list is gone");
});

test("the produce stage writes no variant for an attribute the brain does not supply", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  await seedPlannableAd(sql);
  // A brain with only the offers the brand wrote: the only variant it can give is a call to action.
  await sql`update brand_brains set problems = '', differentiators = '', proof_points = '', preferred_formats = '' where brand_id = ${FACTORY_TEST_BRAND}`;
  const engine = new FixtureDecisionEngine({ respond: (spec) => (spec.type === "choice" ? { choice: "low_risk" } : { probability: 0.99 }) });
  const seams: FactorySeams = {
    decisionEngines: { jev: engine, "openai-decisions": new FixtureDecisionEngine({ id: "openai-decisions", health: NOT_CONFIGURED }) },
  };
  const payload = { runId: FACTORY_TEST_RUN };
  await executeFactoryJob(sql, factoryJob("factory.grade"), payload, undefined, seams);
  await executeFactoryJob(sql, factoryJob("factory.pick"), payload);
  await executeFactoryJob(sql, factoryJob("factory.template"), payload);
  await executeFactoryJob(sql, factoryJob("factory.produce"), payload);

  const attributes = await sql<{ tests_attribute: string }>`
    select tests_attribute from factory_variants where template_id = ${`tpl:${FACTORY_TEST_RUN}:ad-1`}
  `;
  assert.deepEqual(attributes.map((row) => row.tests_attribute).sort(), ["control", "cta"]);
});

test("a pick with no engine decision behind it gets no plan, and so no variant", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: FULL_WITH_CAP, level: 3 });
  await seedPlannableAd(sql);
  const payload = { runId: FACTORY_TEST_RUN };
  // No engine is ready: the grade is observed only, so no gate record backs the ad.
  const seams: FactorySeams = {
    decisionEngines: { jev: new FixtureDecisionEngine({ health: NOT_CONFIGURED }), "openai-decisions": new FixtureDecisionEngine({ id: "openai-decisions", health: NOT_CONFIGURED }) },
  };
  await executeFactoryJob(sql, factoryJob("factory.grade"), payload, undefined, seams);
  await executeFactoryJob(sql, factoryJob("factory.pick"), payload);
  assert.equal(await executeFactoryJob(sql, factoryJob("factory.template"), payload), "templates:1;plans:0;refused:1");
  const [template] = await sql<{ plan: string }>`select plan from factory_templates where id = ${`tpl:${FACTORY_TEST_RUN}:ad-1`}`;
  assert.equal(template?.plan, "", "no plan is stored without a decision");
  assert.equal(await executeFactoryJob(sql, factoryJob("factory.produce"), payload), "variants:0");
  const [count] = await sql<{ n: number }>`select count(*)::int as n from factory_variants where organization_id = ${FACTORY_TEST_ORG}`;
  assert.equal(count?.n, 0, "no variant is written without a plan");
});
