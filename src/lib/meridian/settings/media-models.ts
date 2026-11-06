// The workspace's Studio image and video models (migration 0154, owner direction 2026-11-06): the model OpenRouter makes Studio images and
// Studio videos with, through the workspace's OpenRouter key. They are stored beside the text tasks' models (generation_task_models), but
// checked against the live catalogue's image and video listings, not its text models. Only a pinned id the listing names is saved, with a
// stated price; an alias moves to new builds, so it is refused. Clearing a seat needs no catalogue, and the Studio's own providers apply.
import type { Sql } from "../learning/store.ts";
import { isPinnedModelId } from "./generation-models.ts";

export const MEDIA_TASKS = {
  studio_image: {
    label: "Studio image model",
    kind: "image",
    description: "Makes the Studio's creative images through the workspace's OpenRouter key. Without a choice, the Studio uses its Google image key when one is saved.",
  },
  studio_video: {
    label: "Studio video model",
    kind: "video",
    description: "Makes the Studio's videos through the workspace's OpenRouter key. Without a choice, the Studio uses Gemini Omni or a server-set provider when one is ready.",
  },
} as const;
export type MediaTask = keyof typeof MEDIA_TASKS;
export const MEDIA_TASK_IDS = Object.keys(MEDIA_TASKS) as MediaTask[];

export function isMediaTask(value: unknown): value is MediaTask {
  return typeof value === "string" && (MEDIA_TASK_IDS as string[]).includes(value);
}

/** One image or video model as the live listing states it. A price that is not stated is null, never 0. */
export type MediaModelChoice = {
  id: string;
  name: string;
  kind: "image" | "video";
  /** USD per image, for an image model. */
  imageUsd: number | null;
  /** USD per second at the resolution a Studio job asks for, for a video model (production/openrouter-video.ts studioVideoPrice). */
  usdPerSecond: number | null;
};

/** Whether a listed model may serve a media seat: the right kind, a pinned id, and a stated price. */
export function eligibleForMediaTask(task: MediaTask, choice: MediaModelChoice): { ok: true } | { ok: false; reason: string } {
  const kind = MEDIA_TASKS[task].kind;
  if (choice.kind !== kind) return { ok: false, reason: `${choice.id} is not ${kind === "image" ? "an image" : "a video"} model.` };
  if (!isPinnedModelId(choice.id)) return { ok: false, reason: `${choice.id} is not a pinned id.` };
  const price = kind === "image" ? choice.imageUsd : choice.usdPerSecond;
  if (price === null) return { ok: false, reason: `The listing states no ${kind === "image" ? "per-image" : "per-second"} price for ${choice.id}, so its cost cannot be shown.` };
  return { ok: true };
}

export type StoredMediaModel = { modelId: string; updatedAt: string; updatedBy: string };

export async function storedMediaModels(sql: Sql, organizationId: string): Promise<Partial<Record<MediaTask, StoredMediaModel>>> {
  const rows = await sql<{ task: string; model_id: string; updated_by: string; updated_at: unknown }>`
    select task, model_id, updated_by, updated_at from generation_task_models where organization_id = ${organizationId}
  `;
  const stored: Partial<Record<MediaTask, StoredMediaModel>> = {};
  for (const row of rows) {
    if (!isMediaTask(row.task)) continue;
    stored[row.task] = { modelId: row.model_id, updatedAt: new Date(row.updated_at as string).toISOString(), updatedBy: row.updated_by };
  }
  return stored;
}

/** The stored model id for one media seat in one workspace, or null. */
export async function storedMediaModel(sql: Sql, organizationId: string, task: MediaTask): Promise<string | null> {
  const rows = await sql<{ model_id: string }>`
    select model_id from generation_task_models where organization_id = ${organizationId} and task = ${task} limit 1
  `;
  return rows[0]?.model_id ?? null;
}

/**
 * Stores or clears one media seat's model. `choices` is the live catalogue's image and video models, read by the caller; null means it
 * could not be read, and then nothing is saved.
 */
export async function saveMediaModel(
  sql: Sql,
  input: { organizationId: string; task: MediaTask; modelId: string | null; actorId: string; choices: MediaModelChoice[] | null },
): Promise<{ status: "saved"; modelId: string } | { status: "cleared"; task: MediaTask }> {
  if (input.modelId === null) {
    await sql`delete from generation_task_models where organization_id = ${input.organizationId} and task = ${input.task}`;
    return { status: "cleared", task: input.task };
  }
  if (input.choices === null) throw new Error("The live OpenRouter catalogue could not be read, so this model cannot be checked. Nothing was saved.");
  const choice = input.choices.find((item) => item.id === input.modelId);
  if (!choice) throw new Error(`${input.modelId} is not in the live catalogue's ${MEDIA_TASKS[input.task].kind} models. Nothing was saved.`);
  const eligible = eligibleForMediaTask(input.task, choice);
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
