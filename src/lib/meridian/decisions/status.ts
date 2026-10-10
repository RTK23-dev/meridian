/**
 * Decision-engine status for the control panel: which engine is active and why, and whether each engine is ready.
 *
 * Health reports configuration only. Neither engine makes a live request to answer a status question, so a READY
 * status here means the required credentials and settings are present, not that the provider has been reached.
 */
import type { Sql } from "../learning/store.ts";
import { DECISION_ENGINE_LABELS, createDecisionEngines, jevCallContext, type DecisionEngineRegistry } from "./dispatcher.ts";
import { resolveActiveEngine, type EngineSelection } from "./selection.ts";
import { DECISION_ENGINE_IDS, type DecisionCapabilities, type DecisionEngineHealth, type DecisionEngineId } from "./types.ts";

export type DecisionEngineStatus = {
  active: EngineSelection;
  engines: Array<{
    id: DecisionEngineId;
    label: string;
    isActive: boolean;
    health: DecisionEngineHealth;
    adapterVersion: string;
    capabilities: DecisionCapabilities;
  }>;
};

export async function getDecisionEngineStatus(
  sql: Sql | undefined,
  organizationId: string | undefined,
  engines: DecisionEngineRegistry = createDecisionEngines(),
): Promise<DecisionEngineStatus> {
  const active = await resolveActiveEngine(sql, organizationId);
  const rows = await Promise.all(
    DECISION_ENGINE_IDS.map(async (id) => {
      const engine = engines[id];
      return {
        id,
        label: DECISION_ENGINE_LABELS[id],
        isActive: id === active.engineId,
        health: await engine.health(id === "jev" ? await jevCallContext(sql, organizationId) : undefined),
        adapterVersion: engine.adapterVersion,
        capabilities: engine.capabilities(),
      };
    }),
  );
  return { active, engines: rows };
}
