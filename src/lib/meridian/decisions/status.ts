/**
 * Decision-engine status for the control panel: which engine is active and why, and whether each engine is ready.
 *
 * Health reports configuration only. Neither engine makes a live request to answer a status question, so a READY
 * status here means the required credentials and settings are present, not that the provider has been reached.
 */
import type { Sql } from "../learning/store.ts";
import { DECISION_ENGINE_LABELS, createDecisionEngines, type DecisionEngineRegistry } from "./dispatcher.ts";
import { resolveActiveEngine, type EngineSelection } from "./selection.ts";
import { resolveOpenRouterDecisionModel } from "./openrouter-engine.ts";
import { readOpenRouterModel } from "./openrouter-settings.ts";
import { DECISION_ENGINE_IDS, type DecisionCapabilities, type DecisionEngineHealth, type DecisionEngineId } from "./types.ts";

export type DecisionEngineStatus = {
  active: EngineSelection;
  /** The OpenRouter decision model this workspace would use, and where it comes from. `reason` is set when it cannot be used. */
  openrouterModel: { model: string; source: "workspace" | "deployment" | "default"; reason?: string };
  engines: Array<{
    id: DecisionEngineId;
    label: string;
    isActive: boolean;
    health: DecisionEngineHealth;
    adapterVersion: string;
    capabilities: DecisionCapabilities;
  }>;
};

/** The OpenRouter model for one workspace. A stored choice that cannot be read is reported as unreadable, never replaced by the default. */
async function openrouterModelFor(sql: Sql | undefined, organizationId: string | undefined): Promise<DecisionEngineStatus["openrouterModel"]> {
  let workspace: string | null = null;
  if (sql && organizationId) {
    try {
      workspace = await readOpenRouterModel(sql, organizationId);
    } catch {
      return { model: "", source: "workspace", reason: "The workspace's OpenRouter decision model could not be read." };
    }
  }
  const resolved = resolveOpenRouterDecisionModel({ workspace, deployment: process.env.OPENROUTER_DECISIONS_MODEL });
  return resolved.ok ? { model: resolved.model, source: resolved.source } : { model: resolved.model, source: resolved.source, reason: resolved.reason };
}

export async function getDecisionEngineStatus(
  sql: Sql | undefined,
  organizationId: string | undefined,
  engines: DecisionEngineRegistry = createDecisionEngines(),
): Promise<DecisionEngineStatus> {
  const active = await resolveActiveEngine(sql, organizationId);
  const openrouterModel = await openrouterModelFor(sql, organizationId);
  const rows = await Promise.all(
    DECISION_ENGINE_IDS.map(async (id) => {
      const engine = engines[id];
      return {
        id,
        label: DECISION_ENGINE_LABELS[id],
        isActive: id === active.engineId,
        // With a workspace in scope, each engine reports its readiness for that workspace. Without one, it cannot be READY.
        health: organizationId && engine.healthFor ? await engine.healthFor(organizationId) : await engine.health(),
        adapterVersion: engine.adapterVersion,
        capabilities: engine.capabilities(),
      };
    }),
  );
  return { active, openrouterModel, engines: rows };
}
