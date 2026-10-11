/**
 * Reads a brand's saved factory pipeline configuration. The server function that the screen calls and any runtime reader use
 * this one loader, so they cannot disagree.
 *
 * A saved row is what the brand set. Without a row, the documented defaults are used. A database error throws. It never
 * becomes the defaults, because that would show, or later run, values that nobody saved.
 */
import type { Sql } from "../learning/store.ts";
import { getDefaultPipelineConfig, validatePipelineConfig, type FactoryPipelineConfig } from "./pipeline-config.ts";

export async function loadFactoryPipelineConfig(sql: Sql, organizationId: string, brandId: string): Promise<FactoryPipelineConfig> {
  const rows = await sql<{
    preset_name: string;
    stages: unknown;
    prompts: unknown;
    generation_params: unknown;
    grading_thresholds: unknown;
  }>`
    select preset_name, stages, prompts, generation_params, grading_thresholds
    from factory_pipeline_configs
    where brand_id = ${brandId} and organization_id = ${organizationId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return getDefaultPipelineConfig();
  return validatePipelineConfig({
    presetName: row.preset_name as FactoryPipelineConfig["presetName"],
    stages: row.stages as FactoryPipelineConfig["stages"],
    prompts: row.prompts as FactoryPipelineConfig["prompts"],
    generationParams: row.generation_params as FactoryPipelineConfig["generationParams"],
    gradingThresholds: row.grading_thresholds as FactoryPipelineConfig["gradingThresholds"],
  });
}
