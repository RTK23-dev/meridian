// The bridge between a brand's factory line (factory_pipeline_configs) and cookbooks (round 3, K8). A saved factory configuration is also written
// as the brand's cookbook, so the cookbook library shows it and the resolver reads it. Loading prefers that cookbook and falls back to the old
// row only when no cookbook exists yet. A preset's origin is its parent built-in; a custom line has no parent, and its preset name is "custom".
//
// The configuration is round-tripped exactly: a saved line, written as a cookbook and resolved with no changes, gives back the same
// configuration (the test checks it). The factory's own validator still clamps every value on the way in.

import { createHash } from "node:crypto";
import { contentHash } from "../../../engine/contracts/hash.ts";
import { PIPELINE_PRESETS, validatePipelineConfig, type FactoryPipelineConfig } from "../factory/pipeline-config.ts";
import type { Sql } from "../learning/store.ts";
import { factoryPresetCookbook, FACTORY_PRESET_NAMES, pipelineConfigFromCookbook } from "./builtin/factory-presets.ts";
import { resolveCookbook } from "./resolve.ts";
import type { Cookbook } from "./schema.ts";
import type { Control } from "./controls.ts";
import { validateCookbook } from "./validate.ts";
import { getCookbookVersion, saveCookbookVersion, type StoredCookbook, type StoreResult } from "./store.ts";

const PROMPT_ROLE = { briefPrompt: "plan", scriptPrompt: "script", perceptionPrompt: "visual", gradingPrompt: "critic" } as const;

/** The cookbook id of a brand's factory line: `ck_bf_` and 16 hex characters of the brand id's hash. Never a built-in id. */
export function factoryCookbookId(brandId: string): string {
  return `ck_bf_${createHash("sha256").update(brandId).digest("hex").slice(0, 16)}`;
}

/** The preset a factory cookbook came from: its parent built-in, or "custom" when it has none. */
export function presetNameOf(cookbook: Cookbook): FactoryPipelineConfig["presetName"] {
  const parent = cookbook.parent?.cookbookId ?? "";
  for (const name of FACTORY_PRESET_NAMES) if (parent === `ck_factory_${name}`) return name;
  return "custom";
}

/** The cookbook of a brand's factory configuration: the preset's cookbook, with the saved values as its defaults and its own prompts and labels. */
export function cookbookFromFactoryConfig(config: FactoryPipelineConfig, brandId: string): Cookbook {
  const validated = validatePipelineConfig(config);
  const base: FactoryPipelineConfig["presetName"] = validated.presetName !== "custom" && validated.presetName in PIPELINE_PRESETS ? validated.presetName : "manual_cloud";
  const cookbook = factoryPresetCookbook(base as (typeof FACTORY_PRESET_NAMES)[number]);
  const stageById = new Map<string, FactoryPipelineConfig["stages"][number]>(validated.stages.map((stage) => [stage.id, stage]));

  const steps = cookbook.steps.map((step) => {
    const stage = stageById.get(step.id);
    if (!stage) return step;
    return { ...step, label: stage.label, params: { ...step.params, category: stage.category, description: stage.description } };
  });
  const setParams = (stepId: string, values: Record<string, string | number | boolean>) => {
    const index = steps.findIndex((step) => step.id === stepId);
    const step = steps[index];
    if (step) steps[index] = { ...step, params: { ...step.params, ...values } };
  };
  const g = validated.generationParams;
  setParams("produce", {
    video_count: g.videoCount,
    aspect_ratio: g.aspectRatio,
    duration_seconds: g.durationSeconds,
    daily_generation_cap: g.dailyGenerationCap,
    provider: g.provider,
    render_pacing: g.renderPacing,
  });
  const t = validated.gradingThresholds;
  setParams("grade", {
    winner_score_min: t.winnerScoreMin,
    p_beat_min: t.pBeatMin,
    retention_3s_min: t.retention3sMin,
    confidence_min: t.confidenceMin,
    auto_approve_enabled: t.autoApproveEnabled,
    strict_claim_gate: t.strictClaimGate,
  });

  const defaults = new Map<string, string | number | boolean>([
    ...validated.stages.map((stage) => [`stage_${stage.id}`, stage.enabled] as const),
    ["video_count", g.videoCount],
    ["aspect_ratio", g.aspectRatio],
    ["duration_seconds", g.durationSeconds],
    ["daily_generation_cap", g.dailyGenerationCap],
    ["provider", g.provider],
    ["render_pacing", g.renderPacing],
    ["winner_score_min", t.winnerScoreMin],
    ["p_beat_min", t.pBeatMin],
    ["retention_3s_min", t.retention3sMin],
    ["confidence_min", t.confidenceMin],
    ["auto_approve", t.autoApproveEnabled],
    ["strict_claim_gate", t.strictClaimGate],
  ]);
  const controls = cookbook.controls.map((control) => withDefault(control, defaults.get(control.id)));

  const instructions = (Object.keys(PROMPT_ROLE) as Array<keyof typeof PROMPT_ROLE>).map((key) => ({
    role: PROMPT_ROLE[key],
    text: validated.prompts[key],
  }));

  return {
    ...cookbook,
    cookbookId: factoryCookbookId(brandId),
    version: 1,
    label: validated.presetName === "custom" ? "Factory line (custom)" : `Factory line (${validated.presetName})`,
    summary: "The brand's factory line, saved from the pipeline editor.",
    scope: "workspace",
    parent: validated.presetName === "custom" ? undefined : { cookbookId: `ck_factory_${validated.presetName}`, version: 1 },
    steps,
    controls,
    instructions,
  };
}

/** The control with a new default, when the value has the control's own type. A value of another type keeps the preset's default. */
function withDefault(control: Control, value: string | number | boolean | undefined): Control {
  if (value === undefined) return control;
  if (control.kind === "toggle" && typeof value === "boolean") return { ...control, default: value };
  if (control.kind === "slider" && typeof value === "number") return { ...control, default: value };
  if (control.kind === "select" && typeof value === "string") return { ...control, default: value };
  return control;
}

/** The factory configuration a stored factory cookbook gives back, with no value changed. */
export function factoryConfigOfCookbook(cookbook: Cookbook): FactoryPipelineConfig | null {
  const resolved = resolveCookbook(cookbook, { lengthMs: 1 });
  if (!resolved.ok) return null;
  return pipelineConfigFromCookbook(resolved.resolved, presetNameOf(cookbook));
}

/**
 * Saves a brand's factory configuration as its cookbook, if it differs from the latest version. Writing the same configuration twice gives one
 * version. The configuration is clamped by the factory's validator first.
 */
/**
 * Saves a brand's factory line as its cookbook (K20). The factory line no longer writes factory_pipeline_configs: the cookbook is the only
 * write. A save the cookbook refuses is an error, so nothing is reported as saved that was not. Returns the validated line.
 */
export async function saveFactoryLine(
  sql: Sql,
  input: { organizationId: string; brandId: string; config: Partial<FactoryPipelineConfig>; createdBy: string },
): Promise<FactoryPipelineConfig> {
  const validated = validatePipelineConfig(input.config);
  const saved = await saveFactoryCookbook(sql, { organizationId: input.organizationId, brandId: input.brandId, config: validated, createdBy: input.createdBy });
  if (!saved.ok) throw new Error(saved.issues?.join("; ") || saved.reason);
  return validated;
}

export async function saveFactoryCookbook(
  sql: Sql,
  input: { organizationId: string; brandId: string; config: Partial<FactoryPipelineConfig>; createdBy: string },
): Promise<StoreResult<StoredCookbook>> {
  const cookbook = cookbookFromFactoryConfig(validatePipelineConfig(input.config), input.brandId);
  const checked = validateCookbook(cookbook);
  if (!checked.ok) return { ok: false, reason: "invalid", issues: checked.issues };
  const latest = await getCookbookVersion(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: cookbook.cookbookId });
  if (latest.ok && contentHash({ ...latest.value.cookbook, version: 0 }) === contentHash({ ...checked.cookbook, version: 0 })) {
    return { ok: true, value: latest.value };
  }
  return saveCookbookVersion(sql, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    cookbook: checked.cookbook,
    createdBy: input.createdBy,
  });
}

/** The brand's factory configuration from its cookbook, or null when none has been written yet (the caller then reads the old row). */
export async function loadFactoryCookbook(sql: Sql, input: { organizationId: string; brandId: string }): Promise<FactoryPipelineConfig | null> {
  const stored = await getCookbookVersion(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: factoryCookbookId(input.brandId) });
  if (!stored.ok) return null;
  return factoryConfigOfCookbook(stored.value.cookbook);
}

/**
 * Writes every saved factory row of a workspace as a cookbook. Running it again writes nothing for a row that has not changed, so it can be run
 * any number of times. Returns how many rows were written and how many were already current.
 */
export async function migrateFactoryPipelineConfigs(
  sql: Sql,
  input: { organizationId: string },
): Promise<{ written: number; current: number; refused: number }> {
  const rows = await sql<{
    brand_id: string;
    preset_name: string;
    stages: unknown;
    prompts: unknown;
    generation_params: unknown;
    grading_thresholds: unknown;
    updated_by: string;
  }>`
    select brand_id, preset_name, stages, prompts, generation_params, grading_thresholds, updated_by
    from factory_pipeline_configs where organization_id = ${input.organizationId}
  `;
  let written = 0;
  let current = 0;
  let refused = 0;
  for (const row of rows) {
    const config = validatePipelineConfig({
      presetName: row.preset_name as FactoryPipelineConfig["presetName"],
      stages: row.stages as FactoryPipelineConfig["stages"],
      prompts: row.prompts as FactoryPipelineConfig["prompts"],
      generationParams: row.generation_params as FactoryPipelineConfig["generationParams"],
      gradingThresholds: row.grading_thresholds as FactoryPipelineConfig["gradingThresholds"],
    });
    const before = await getCookbookVersion(sql, { organizationId: input.organizationId, brandId: row.brand_id, cookbookId: factoryCookbookId(row.brand_id) });
    const saved = await saveFactoryCookbook(sql, { organizationId: input.organizationId, brandId: row.brand_id, config, createdBy: row.updated_by });
    if (!saved.ok) refused += 1;
    else if (before.ok && before.value.version === saved.value.version) current += 1;
    else written += 1;
  }
  return { written, current, refused };
}

