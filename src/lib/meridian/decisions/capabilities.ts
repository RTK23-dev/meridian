/**
 * What each decision engine can take, in one exhaustive table. Callers ask this instead of comparing an engine ID, so an engine's
 * image support is decided where its adapter is classified, and a new engine cannot quietly take the wrong branch: the table
 * must name every engine, or it does not compile.
 *
 * OpenRouter's verified decision models take images, but only some of them, so the per-decision check in the adapter (its
 * model's verified capabilities) is what actually decides. This table answers only whether the engine can take images at all.
 */
import type { Sql } from "../learning/store.ts";
import { decisionModelProfile } from "./decision-catalog.ts";
import { DEFAULT_JEV_BACKEND, readJevBackend } from "./jev-backend.ts";
import { resolveOpenRouterDecisionModel } from "./openrouter-engine.ts";
import { readOpenRouterModel } from "./openrouter-settings.ts";
import type { EngineSelection } from "./selection.ts";
import type { DecisionEngineId, DecisionRequest } from "./types.ts";

const ACCEPTS_IMAGES: Record<DecisionEngineId, boolean> = {
  jev: false,
  "openai-decisions": true,
  "openrouter-decisions": true,
};

/** Whether the engine can take image evidence. A text-only engine gets the text evidence and records that no images were seen. */
export function engineAcceptsImages(engineId: DecisionEngineId): boolean {
  return ACCEPTS_IMAGES[engineId];
}

export type ResolvedImageSupport = {
  takesImages: boolean;
  /** The backend and OpenRouter model this decision uses. The gate passes them to the engine, which uses them without reading again. */
  resolved: NonNullable<DecisionRequest["resolved"]>;
  /** Why images are or are not taken, for the record. */
  reason: string;
};

/**
 * Whether the engine this decision will call can take image evidence for this workspace, resolved once before the decision starts.
 * For JEV the answer depends on its backend and, through OpenRouter, on the model the workspace chose: a model whose verified profile has
 * no image input takes none. An unreadable setting takes no images, so a visual question goes to review rather than being judged without
 * its image.
 */
export async function resolveImageSupport(input: {
  selection: EngineSelection;
  sql: Sql | undefined;
  organizationId: string | undefined;
}): Promise<ResolvedImageSupport> {
  if (input.selection.engineId !== "jev") {
    return { takesImages: engineAcceptsImages(input.selection.engineId), resolved: {}, reason: `${input.selection.engineId} is resolved by its own adapter.` };
  }
  if (!input.sql || !input.organizationId) {
    return { takesImages: false, resolved: {}, reason: "JEV's backend could not be read without a workspace and database, so no image is sent." };
  }
  try {
    const read = await readJevBackend(input.sql, input.organizationId);
    if (!read.ok) return { takesImages: false, resolved: {}, reason: read.reason };
    const backend = read.backend ?? DEFAULT_JEV_BACKEND;
    if (backend === "typesafe_direct") {
      return { takesImages: false, resolved: { jevBackend: backend }, reason: "JEV through TypeSafe takes text evidence only." };
    }
    const workspace = await readOpenRouterModel(input.sql, input.organizationId);
    const model = resolveOpenRouterDecisionModel({ workspace, deployment: process.env.OPENROUTER_DECISIONS_MODEL });
    if (!model.ok) return { takesImages: false, resolved: { jevBackend: backend }, reason: model.reason };
    const takesImages = decisionModelProfile(model.model)?.inputModalities.includes("image") ?? false;
    return {
      takesImages,
      resolved: { jevBackend: backend, openrouterModel: { model: model.model, source: model.source } },
      reason: takesImages
        ? `JEV through OpenRouter uses ${model.model}, which takes image evidence.`
        : `${model.model} takes no images, so image evidence is not sent to it.`,
    };
  } catch {
    return { takesImages: false, resolved: {}, reason: "JEV's backend or model could not be read, so no image is sent." };
  }
}
