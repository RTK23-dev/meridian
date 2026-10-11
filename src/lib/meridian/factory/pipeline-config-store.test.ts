import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getDefaultPipelineConfig, validatePipelineConfig, type FactoryPipelineConfig } from "./pipeline-config.ts";
import { loadFactoryPipelineConfig } from "./pipeline-config-store.ts";
import { openTestBackends } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import type { Sql } from "../learning/store.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

for (const { name, sql } of backends) {
  test(`[${name}] a brand with no saved row gets the documented defaults, and only then`, async () => {
    const tenant = await studioTenant(sql, `pipeline-none-${name}`);
    const loaded = await loadFactoryPipelineConfig(sql, tenant.organizationId, tenant.brandId);
    assert.deepEqual(loaded, getDefaultPipelineConfig());
  });

  test(`[${name}] a saved row is what the loader returns, and another workspace's row is never read`, async () => {
    const owner = await studioTenant(sql, `pipeline-saved-${name}`);
    const other = await studioTenant(sql, `pipeline-other-${name}`);
    const saved: FactoryPipelineConfig = validatePipelineConfig({
      presetName: "custom",
      gradingThresholds: { ...getDefaultPipelineConfig().gradingThresholds, winnerScoreMin: 0.91, strictClaimGate: false },
      generationParams: { ...getDefaultPipelineConfig().generationParams, videoCount: 7 },
    });
    await sql`
      insert into factory_pipeline_configs (
        id, organization_id, brand_id, preset_name, stages, prompts, generation_params, grading_thresholds, updated_by, updated_at
      ) values (
        ${`fpc_test_${owner.organizationId}`}, ${owner.organizationId}, ${owner.brandId}, ${saved.presetName},
        ${JSON.stringify(saved.stages)}::jsonb, ${JSON.stringify(saved.prompts)}::jsonb,
        ${JSON.stringify(saved.generationParams)}::jsonb, ${JSON.stringify(saved.gradingThresholds)}::jsonb,
        ${owner.userId}, now()
      )
    `;

    const loaded = await loadFactoryPipelineConfig(sql, owner.organizationId, owner.brandId);
    assert.equal(loaded.gradingThresholds.winnerScoreMin, 0.91);
    assert.equal(loaded.gradingThresholds.strictClaimGate, false);
    assert.equal(loaded.generationParams.videoCount, 7);

    const elsewhere = await loadFactoryPipelineConfig(sql, other.organizationId, other.brandId);
    assert.deepEqual(elsewhere, getDefaultPipelineConfig(), "another workspace gets its own defaults, not this row");
  });
}

test("a database error refuses: the loader throws and never returns the defaults", async () => {
  const failing = (async () => {
    throw new Error("connection refused");
  }) as unknown as Sql;
  await assert.rejects(loadFactoryPipelineConfig(failing, "org-1", "brand-1"), /connection refused/);
});
