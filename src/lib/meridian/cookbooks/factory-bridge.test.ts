// The factory bridge (K8) on PGlite: a saved factory line round-trips exactly through its cookbook; the factory's own clamps still apply;
// writing the same line twice is one version; another brand sees nothing; the migration of old rows is idempotent.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getPresetConfig, validatePipelineConfig, type FactoryPipelineConfig } from "../factory/pipeline-config.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { factoryCookbookId, loadFactoryCookbook, migrateFactoryPipelineConfigs, saveFactoryCookbook, saveFactoryLine } from "./factory-bridge.ts";
import { getCookbookVersion } from "./store.ts";

const ORG = "org_factory_bridge";
const BRAND_A = "brand_factory_a";
const BRAND_B = "brand_factory_b";
const BRAND_C = "brand_factory_c";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND_A);
  await seedWorkspace(db.sql, ORG, BRAND_B);
  await seedWorkspace(db.sql, ORG, BRAND_C);
});

after(async () => {
  await db.close();
});

test("each preset round-trips exactly through its cookbook", async () => {
  for (const name of ["viral_ugc", "problem_solution", "strict_quality", "manual_cloud"] as const) {
    const brand = `${BRAND_A}_${name}`;
    await seedWorkspace(db.sql, ORG, brand);
    const config = getPresetConfig(name);
    const saved = await saveFactoryCookbook(db.sql, { organizationId: ORG, brandId: brand, config, createdBy: "u_a" });
    assert.equal(saved.ok, true, name);
    const loaded = await loadFactoryCookbook(db.sql, { organizationId: ORG, brandId: brand });
    assert.deepEqual(loaded, validatePipelineConfig(config), name);
  }
});

test("a changed line is saved with its changes, and the factory's clamps still apply", async () => {
  const config: FactoryPipelineConfig = {
    ...getPresetConfig("viral_ugc"),
    generationParams: { ...getPresetConfig("viral_ugc").generationParams, videoCount: 99, durationSeconds: 20 },
    gradingThresholds: { ...getPresetConfig("viral_ugc").gradingThresholds, winnerScoreMin: 0.3, autoApproveEnabled: true },
    stages: getPresetConfig("viral_ugc").stages.map((stage) => (stage.id === "launch" ? { ...stage, enabled: false } : stage)),
  };
  await saveFactoryCookbook(db.sql, { organizationId: ORG, brandId: BRAND_B, config, createdBy: "u_b" });
  const loaded = await loadFactoryCookbook(db.sql, { organizationId: ORG, brandId: BRAND_B });
  assert.deepEqual(loaded, validatePipelineConfig(config));
  assert.equal(loaded?.generationParams.videoCount, 10, "the factory clamps 99 to 10");
  assert.equal(loaded?.gradingThresholds.winnerScoreMin, 0.5, "and 0.3 to 0.5");
  assert.equal(loaded?.stages.find((stage) => stage.id === "launch")?.enabled, false);
});

test("writing the same line twice is one version; a change is the next version", async () => {
  const config = getPresetConfig("strict_quality");
  const first = await saveFactoryCookbook(db.sql, { organizationId: ORG, brandId: BRAND_C, config, createdBy: "u_c" });
  const again = await saveFactoryCookbook(db.sql, { organizationId: ORG, brandId: BRAND_C, config, createdBy: "u_c" });
  assert.equal(first.ok && again.ok && first.value.version === again.value.version, true);
  const changed = await saveFactoryCookbook(db.sql, {
    organizationId: ORG,
    brandId: BRAND_C,
    config: { ...config, generationParams: { ...config.generationParams, videoCount: 4 } },
    createdBy: "u_c",
  });
  assert.equal(changed.ok && changed.value.version, 2);
});

test("another brand sees no factory line", async () => {
  const fromOther = await loadFactoryCookbook(db.sql, { organizationId: ORG, brandId: "brand_factory_nobody" });
  assert.equal(fromOther, null);
  const row = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: factoryCookbookId(BRAND_B) });
  assert.equal(row.ok, false, "a brand's factory cookbook is not visible to another brand");
});

test("the migration writes each saved row once, and running it again writes nothing", async () => {
  const migrating = `${ORG}_migrate`;
  const brandX = "brand_migrate_x";
  const brandY = "brand_migrate_y";
  await seedWorkspace(db.sql, migrating, brandX);
  await seedWorkspace(db.sql, migrating, brandY);
  const rows: Array<[string, FactoryPipelineConfig]> = [
    [brandX, getPresetConfig("problem_solution")],
    [brandY, { ...getPresetConfig("manual_cloud"), presetName: "custom" }],
  ];
  for (const [brandId, config] of rows) {
    await db.sql`
      insert into factory_pipeline_configs (id, organization_id, brand_id, preset_name, stages, prompts, generation_params, grading_thresholds, updated_by)
      values (${`fpc_${brandId}`}, ${migrating}, ${brandId}, ${config.presetName}, ${JSON.stringify(config.stages)}::jsonb,
        ${JSON.stringify(config.prompts)}::jsonb, ${JSON.stringify(config.generationParams)}::jsonb,
        ${JSON.stringify(config.gradingThresholds)}::jsonb, 'u_migrate')
    `;
  }
  const first = await migrateFactoryPipelineConfigs(db.sql, { organizationId: migrating });
  assert.deepEqual(first, { written: 2, current: 0, refused: 0 });
  const second = await migrateFactoryPipelineConfigs(db.sql, { organizationId: migrating });
  assert.deepEqual(second, { written: 0, current: 2, refused: 0 }, "a second run finds every row already current");
  assert.deepEqual(await loadFactoryCookbook(db.sql, { organizationId: migrating, brandId: brandX }), validatePipelineConfig(rows[0]![1]));
  assert.deepEqual(await loadFactoryCookbook(db.sql, { organizationId: migrating, brandId: brandY }), validatePipelineConfig(rows[1]![1]));
});

test("a saved factory line is written as its cookbook only: no row goes to the old factory_pipeline_configs table (K20)", async () => {
  const brand = "brand_factory_k20";
  await db.sql`insert into brands (id, organization_id, name, created_by) values (${brand}, ${ORG}, ${brand}, 'test') on conflict (id) do nothing`;
  const countOld = async (): Promise<number> => {
    const rows = await db.sql<{ n: number }>`select count(*)::int as n from factory_pipeline_configs where organization_id = ${ORG} and brand_id = ${brand}`;
    return rows[0]?.n ?? -1;
  };
  assert.equal(await countOld(), 0);
  const saved = await saveFactoryLine(db.sql, { organizationId: ORG, brandId: brand, config: getPresetConfig("viral_ugc"), createdBy: "user_k20" });
  assert.deepEqual(saved, validatePipelineConfig(getPresetConfig("viral_ugc")), "the line is returned as validated");
  assert.equal(await countOld(), 0, "the old table is not written");
  const stored = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: brand, cookbookId: factoryCookbookId(brand) });
  assert.equal(stored.ok, true, "the cookbook holds the line");
});
