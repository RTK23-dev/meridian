// The orchestrator's model for a workspace (migration 0109), chosen in the Content Factory panel. Stored as an OpenRouter id. The id's shape
// is checked here; whether the catalog lists it as a text model is checked by the caller, because the catalog may not be connected yet.
// Every read and write is scoped to the organization. Browser-safe: no Node-only imports.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { CatalogEntry } from "./catalog.ts";

export const ORCHESTRATOR_MODEL_ID = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/** The id is a vendor/model, with an optional ~ for a live alias. Anything else is refused before it is stored. */
export function isOrchestratorModelId(value: string): boolean {
  return value.length >= 3 && value.length <= 200 && ORCHESTRATOR_MODEL_ID.test(value);
}

/** A text model the orchestrator may plan with: text in, text out, and both per-token prices known, so a plan can be priced. */
export type TextModelChoice = {
  id: string;
  name: string;
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  inputModalities: string[];
  /** The context window in tokens as the listing states it, or null. Image input cannot be priced without it. */
  contextLength: number | null;
};

/**
 * Whether a catalogue entry can be a text-generation model. It must be a text entry whose listed output is text, with both per-token
 * prices known. A decision model lists `decisions` as its output, so it is never eligible here, even when a text listing returned it:
 * decisioning and generation are separate catalogues, and a decision model cannot be chosen to write text.
 */
export function isTextGenerationEntry(entry: CatalogEntry): boolean {
  if (entry.kind !== "text") return false;
  const outputs = entry.output_modalities ?? [];
  if (outputs.includes("decisions") || !outputs.includes("text")) return false;
  return entry.pricing.promptUsdPerToken !== null && entry.pricing.completionUsdPerToken !== null;
}

/** The catalogue's text-generation models, sorted by name then id. Pure. */
export function textChoices(catalog: Map<string, CatalogEntry>): TextModelChoice[] {
  const choices: TextModelChoice[] = [];
  for (const entry of catalog.values()) {
    if (!isTextGenerationEntry(entry)) continue;
    const { promptUsdPerToken, completionUsdPerToken } = entry.pricing;
    if (promptUsdPerToken === null || completionUsdPerToken === null) continue;
    choices.push({
      id: entry.id,
      name: entry.name,
      promptUsdPerToken,
      completionUsdPerToken,
      inputModalities: entry.input_modalities ?? [],
      contextLength: entry.context_length ?? null,
    });
  }
  return choices.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The text-generation models that also take image input, for a task that reads a picture. Pure. */
export function visionChoices(catalog: Map<string, CatalogEntry>): TextModelChoice[] {
  return textChoices(catalog).filter((choice) => choice.inputModalities.includes("image"));
}

/** The workspace's stored model, or null when none is stored. */
export async function getOrchestratorModel(sql: Sql, organizationId: string): Promise<string | null> {
  const rows = await sql<{ orchestrator_model: string }>`
    select orchestrator_model from orchestrator_settings where organization_id = ${organizationId} limit 1
  `;
  return rows[0]?.orchestrator_model ?? null;
}

/** Stores the workspace's model, or clears it with null. A malformed id is refused and nothing is written. */
export async function setOrchestratorModel(sql: Sql, input: { organizationId: string; modelId: string | null; actorId: string }): Promise<void> {
  if (input.modelId === null) {
    await sql`delete from orchestrator_settings where organization_id = ${input.organizationId}`;
    return;
  }
  if (!isOrchestratorModelId(input.modelId)) throw new Error("The orchestrating model must be an OpenRouter id, vendor/model.");
  await sql`
    insert into orchestrator_settings (organization_id, orchestrator_model, updated_by, updated_at)
    values (${input.organizationId}, ${input.modelId}, ${input.actorId}, now())
    on conflict (organization_id) do update set
      orchestrator_model = excluded.orchestrator_model,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `;
}
