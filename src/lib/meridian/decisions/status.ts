/**
 * Decision-engine status for the control panel: which engine is active and why, and whether each engine is ready.
 *
 * Health reports configuration only. Neither engine makes a live request to answer a status question, so a READY
 * status here means the required credentials and settings are present, not that the provider has been reached.
 */
import type { Sql } from "../learning/store.ts";
import { DECISION_ENGINE_LABELS, createDecisionEngines, type DecisionEngineRegistry } from "./dispatcher.ts";
import { resolveActiveEngine, type EngineSelection } from "./selection.ts";
import { OPENROUTER_DECISIONS_MAX_IMAGES, resolveOpenRouterDecisionModel } from "./openrouter-engine.ts";
import { decisionModelProfile } from "./decision-catalog.ts";
import { readOpenRouterModel } from "./openrouter-settings.ts";
import { DEFAULT_JEV_BACKEND, JEV_BACKENDS, JEV_BACKEND_LABELS, readJevBackend, type JevBackend } from "./jev-backend.ts";
import {
  DECISION_ENGINE_IDS,
  type DecisionCapabilities,
  type DecisionEngine,
  type DecisionEngineHealth,
  type DecisionEngineId,
} from "./types.ts";
import { openRouterDecisionsModelSetting } from "../config/server-settings.ts";

export type JevBackendOption = { backend: JevBackend; label: string; health: DecisionEngineHealth };

export type DecisionEngineStatus = {
  active: EngineSelection;
  /** The OpenRouter decision model this workspace would use, and where it comes from. `reason` is set when it cannot be used. */
  openrouterModel: { model: string; source: "workspace" | "deployment" | "none"; reason?: string };
  /** The backend JEV decisions use for this workspace. `backend` is null when a stored value cannot be read, and nothing is assumed. */
  jevBackend: { backend: JevBackend | null; source: "workspace" | "default"; reason?: string };
  /** Readiness of each JEV backend for this workspace, so a switch to it is shown before it is saved. No live request is made. */
  jevBackends: JevBackendOption[];
  engines: Array<{
    id: DecisionEngineId;
    label: string;
    isActive: boolean;
    health: DecisionEngineHealth;
    adapterVersion: string;
    capabilities: DecisionCapabilities;
  }>;
};

/** The JEV backend for one workspace: its stored choice, or the default when none is stored. */
async function jevBackendFor(sql: Sql | undefined, organizationId: string | undefined): Promise<DecisionEngineStatus["jevBackend"]> {
  if (!organizationId) return { backend: DEFAULT_JEV_BACKEND, source: "default" };
  if (!sql) return { backend: null, source: "workspace", reason: "The JEV backend setting could not be read without a database." };
  try {
    const read = await readJevBackend(sql, organizationId);
    if (!read.ok) return { backend: null, source: "workspace", reason: read.reason };
    return read.backend ? { backend: read.backend, source: "workspace" } : { backend: DEFAULT_JEV_BACKEND, source: "default" };
  } catch {
    return { backend: null, source: "workspace", reason: "The JEV backend setting could not be read." };
  }
}

/** A JEV engine that can report readiness for a named backend. The registry's JEV engine is one; a test stub may not be. */
type BackendHealthSource = { healthForBackend(organizationId: string, backend: JevBackend): Promise<DecisionEngineHealth> };

/** The readiness of each JEV backend for one workspace. Without a workspace, or an engine that cannot say, nothing is checked. */
async function jevBackendOptions(jev: DecisionEngine, organizationId: string | undefined): Promise<JevBackendOption[]> {
  const canReport = (engine: DecisionEngine): engine is DecisionEngine & BackendHealthSource =>
    typeof (engine as Partial<BackendHealthSource>).healthForBackend === "function";
  return Promise.all(
    JEV_BACKENDS.map(async (backend) => {
      const label = JEV_BACKEND_LABELS[backend];
      if (!organizationId) {
        return { backend, label, health: { status: "NOT_CONFIGURED", message: "No workspace was given, so nothing was checked." } };
      }
      if (!canReport(jev)) {
        return { backend, label, health: { status: "UNAVAILABLE", message: "This JEV engine cannot report readiness per backend." } };
      }
      return { backend, label, health: await jev.healthForBackend(organizationId, backend) };
    }),
  );
}

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
  const resolved = resolveOpenRouterDecisionModel({ workspace, deployment: openRouterDecisionsModelSetting() });
  return resolved.ok ? { model: resolved.model, source: resolved.source } : { model: resolved.model, source: resolved.source, reason: resolved.reason };
}

/**
 * JEV's capabilities depend on the backend the workspace chose. The engine's own declaration is the TypeSafe path, which takes text
 * only. Through OpenRouter, JEV takes the images the chosen model's verified profile lists, so the status reports those.
 */
function jevCapabilitiesFor(declared: DecisionCapabilities, backend: JevBackend | null, model: string): DecisionCapabilities {
  if (backend !== "openrouter") return declared;
  const takesImages = model !== "" && (decisionModelProfile(model)?.inputModalities.includes("image") ?? false);
  return {
    ...declared,
    inputModalities: takesImages ? ["text", "image"] : ["text"],
    maxImages: takesImages ? OPENROUTER_DECISIONS_MAX_IMAGES : 0,
  };
}

export async function getDecisionEngineStatus(
  sql: Sql | undefined,
  organizationId: string | undefined,
  engines: DecisionEngineRegistry = createDecisionEngines(),
): Promise<DecisionEngineStatus> {
  const active = await resolveActiveEngine(sql, organizationId);
  const openrouterModel = await openrouterModelFor(sql, organizationId);
  const jevBackend = await jevBackendFor(sql, organizationId);
  const jevBackends = await jevBackendOptions(engines.jev, organizationId);
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
        capabilities: id === "jev" ? jevCapabilitiesFor(engine.capabilities(), jevBackend.backend, openrouterModel.model) : engine.capabilities(),
      };
    }),
  );
  return { active, openrouterModel, jevBackend, jevBackends, engines: rows };
}
