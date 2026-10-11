/**
 * Factory Line Pipeline Server Actions
 *
 * Provides typed server functions for fetching, customizing, and applying
 * presets for the modular Content Factory pipeline.
 */

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { loadFactoryPipelineConfig } from "./pipeline-config-store.ts";
import {
  type FactoryPipelineConfig,
  validatePipelineConfig,
  PIPELINE_PRESETS,
} from "./pipeline-config.ts";

function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
  return input as Record<string, unknown>;
}

async function requireBrand(userId: string, brandId: string, minimum: Role) {
  const sql = await getSql();
  const rows = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = rows[0]?.organization_id;
  if (!organizationId) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { sql, organizationId, role };
}

export const getPipelineConfig = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "viewer");
    // The saved row, or the documented defaults when no row exists. A database error is not caught here: it refuses.
    return loadFactoryPipelineConfig(sql, organizationId, data.brandId);
  });

export const savePipelineConfig = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const brandId = clip(body.brandId, 80, "Brand", true);
    const config = body.config && typeof body.config === "object" ? (body.config as Partial<FactoryPipelineConfig>) : {};
    return { brandId, config };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "member");
    const validated = validatePipelineConfig(data.config);
    const id = `fpc_${globalThis.crypto.randomUUID()}`;

    await sql`
      insert into factory_pipeline_configs (
        id, organization_id, brand_id, preset_name, stages, prompts, generation_params, grading_thresholds, updated_by, updated_at
      ) values (
        ${id},
        ${organizationId},
        ${data.brandId},
        ${validated.presetName},
        ${JSON.stringify(validated.stages)}::jsonb,
        ${JSON.stringify(validated.prompts)}::jsonb,
        ${JSON.stringify(validated.generationParams)}::jsonb,
        ${JSON.stringify(validated.gradingThresholds)}::jsonb,
        ${context.userId},
        now()
      )
      on conflict (organization_id, brand_id) do update set
        preset_name = excluded.preset_name,
        stages = excluded.stages,
        prompts = excluded.prompts,
        generation_params = excluded.generation_params,
        grading_thresholds = excluded.grading_thresholds,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;

    return { ok: true, config: validated };
  });

export const applyPipelinePreset = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const brandId = clip(body.brandId, 80, "Brand", true);
    const presetName = clip(body.presetName, 80, "Preset", true);
    return { brandId, presetName };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "member");
    const preset = PIPELINE_PRESETS[data.presetName];
    if (!preset) {
      throw new Error(`Unknown preset: ${data.presetName}`);
    }

    const id = `fpc_${globalThis.crypto.randomUUID()}`;
    await sql`
      insert into factory_pipeline_configs (
        id, organization_id, brand_id, preset_name, stages, prompts, generation_params, grading_thresholds, updated_by, updated_at
      ) values (
        ${id},
        ${organizationId},
        ${data.brandId},
        ${preset.presetName},
        ${JSON.stringify(preset.stages)}::jsonb,
        ${JSON.stringify(preset.prompts)}::jsonb,
        ${JSON.stringify(preset.generationParams)}::jsonb,
        ${JSON.stringify(preset.gradingThresholds)}::jsonb,
        ${context.userId},
        now()
      )
      on conflict (organization_id, brand_id) do update set
        preset_name = excluded.preset_name,
        stages = excluded.stages,
        prompts = excluded.prompts,
        generation_params = excluded.generation_params,
        grading_thresholds = excluded.grading_thresholds,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;

    return { ok: true, config: preset };
  });
