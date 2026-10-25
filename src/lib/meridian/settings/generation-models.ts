// The workspace's model for each ordinary text-generation task (migration 0134): the studio's copy and scripts, the research analysis,
// the brand brain's suggestions and the Factory's image labels. Every read and write is scoped to one organization. A model is saved
// only when the live catalogue lists it as a text model for that task, and only pinned ids are accepted: an alias moves to new builds,
// so it is refused. A decision model is never a text model, so it cannot be saved here.

import type { Sql } from "../learning/store.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";

export const GENERATION_TASKS = {
  copy: {
    label: "Copy and scripts",
    description: "Writes the studio's creative script and its copy.",
    needsImage: false,
  },
  research_analysis: {
    label: "Research analysis",
    description: "Analyses the transcripts of collected ads.",
    needsImage: false,
  },
  brain_suggest: {
    label: "Brand brain suggestions",
    description: "Suggests brand brain fields from a stored page.",
    needsImage: false,
  },
  vision: {
    label: "Image understanding",
    description: "Labels Factory keyframes. Only a model that takes images is accepted, and the deployment default is never used.",
    needsImage: true,
  },
} as const;

export type GenerationTask = keyof typeof GENERATION_TASKS;

export const GENERATION_TASK_IDS = Object.keys(GENERATION_TASKS) as GenerationTask[];

export function isGenerationTask(value: unknown): value is GenerationTask {
  return typeof value === "string" && (GENERATION_TASK_IDS as string[]).includes(value);
}

/** A pinned OpenRouter id, vendor/model. An alias (~) is not pinned, so it is not accepted. */
export const PINNED_MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export function isPinnedModelId(value: string): boolean {
  return value.length >= 3 && value.length <= 200 && PINNED_MODEL_ID.test(value);
}

/** Whether a catalogue text model may be used for a task, and why not when it may not. */
export function eligibleForTask(task: GenerationTask, choice: TextModelChoice): { ok: true } | { ok: false; reason: string } {
  if (GENERATION_TASKS[task].needsImage && !choice.inputModalities.includes("image")) {
    return { ok: false, reason: `${choice.id} does not take images, so it cannot read a Factory keyframe.` };
  }
  return { ok: true };
}

export type StoredGenerationModel = { modelId: string; updatedAt: string; updatedBy: string };

/** The workspace's stored choices, one per task that has one. An unset task is absent, not defaulted. */
export async function storedGenerationModels(sql: Sql, organizationId: string): Promise<Partial<Record<GenerationTask, StoredGenerationModel>>> {
  const rows = await sql<{ task: string; model_id: string; updated_by: string; updated_at: unknown }>`
    select task, model_id, updated_by, updated_at from generation_task_models where organization_id = ${organizationId}
  `;
  const stored: Partial<Record<GenerationTask, StoredGenerationModel>> = {};
  for (const row of rows) {
    if (!isGenerationTask(row.task)) continue;
    stored[row.task] = { modelId: row.model_id, updatedAt: new Date(row.updated_at as string).toISOString(), updatedBy: row.updated_by };
  }
  return stored;
}

/** The stored model id for one task in one workspace, or null. */
export async function storedGenerationModel(sql: Sql, organizationId: string, task: GenerationTask): Promise<string | null> {
  const rows = await sql<{ model_id: string }>`
    select model_id from generation_task_models where organization_id = ${organizationId} and task = ${task} limit 1
  `;
  return rows[0]?.model_id ?? null;
}

export type SaveGenerationModelResult = { status: "saved"; modelId: string } | { status: "cleared"; task: GenerationTask };

/**
 * Stores or clears one task's model. `choices` is the live catalogue's text models, read by the caller. When it is null, the catalogue
 * cannot be checked, so nothing is saved: a model is never stored unverified. Clearing needs no catalogue.
 */
export async function saveGenerationModel(
  sql: Sql,
  input: { organizationId: string; task: GenerationTask; modelId: string | null; actorId: string; choices: TextModelChoice[] | null },
): Promise<SaveGenerationModelResult> {
  if (input.modelId === null) {
    await sql`delete from generation_task_models where organization_id = ${input.organizationId} and task = ${input.task}`;
    return { status: "cleared", task: input.task };
  }
  if (!isPinnedModelId(input.modelId)) {
    throw new Error("A text model must be a pinned OpenRouter id, vendor/model. An alias is not accepted, because it moves to new builds.");
  }
  if (input.choices === null) {
    throw new Error("The live OpenRouter catalogue could not be read, so this model cannot be checked. Nothing was saved.");
  }
  const choice = input.choices.find((item) => item.id === input.modelId);
  if (!choice) {
    throw new Error(`${input.modelId} is not a text model with prices in the live catalogue. Nothing was saved.`);
  }
  const eligible = eligibleForTask(input.task, choice);
  if (!eligible.ok) throw new Error(`${eligible.reason} Nothing was saved.`);
  await sql`
    insert into generation_task_models (organization_id, task, model_id, updated_by, updated_at)
    values (${input.organizationId}, ${input.task}, ${input.modelId}, ${input.actorId}, now())
    on conflict (organization_id, task) do update set
      model_id = excluded.model_id,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `;
  return { status: "saved", modelId: input.modelId };
}
