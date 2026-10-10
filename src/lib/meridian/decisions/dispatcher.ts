/**
 * Decision dispatch: the single entry point for production decisions.
 *
 * `decideWithActiveEngine` resolves the organization's active engine, calls that engine once, records the lineage, and
 * returns the normalized result. It never calls the other engine: there is no automatic fallback, no retry on the other
 * paid route, and no duplicate decision for confidence. The optional shadow evaluation is a separate, opt-in path and
 * is not part of this function.
 */
import type { Sql } from "../learning/store.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import { JevDecisionEngine } from "./jev-engine.ts";
import { OpenAiDecisionsEngine } from "./openai-engine.ts";
import { persistDecisionLineage } from "./lineage.ts";
import { resolveActiveEngine, type EngineSelection } from "./selection.ts";
import type { JevProviderRouter } from "../jev/types.ts";
import {
  DECISION_ENGINE_IDS,
  type DecisionCallContext,
  type DecisionEngine,
  type DecisionEngineId,
  type DecisionRequest,
  type DecisionResult,
} from "./types.ts";

export type DecisionEngineRegistry = Record<DecisionEngineId, DecisionEngine>;

export const DECISION_ENGINE_LABELS: Record<DecisionEngineId, string> = {
  jev: "TypeSafe JEV",
  "openai-decisions": "OpenAI Decisions",
};

/** Builds one instance of each engine. `jevRouter` lets JEV keep the transport the existing router already uses. */
export function createDecisionEngines(options: {
  jevRouter?: JevProviderRouter;
  openai?: OpenAiDecisionsEngine;
} = {}): DecisionEngineRegistry {
  return {
    jev: new JevDecisionEngine(options.jevRouter),
    "openai-decisions": options.openai ?? new OpenAiDecisionsEngine(),
  };
}

/**
 * The TypeSafe key a JEV call for this organization may use, from the one credential resolver. Without a database
 * connection, or without an organization, no workspace key can be read, so the TypeSafe transport is not available.
 */
export async function jevCallContext(sql: Sql | undefined, organizationId: string | undefined): Promise<DecisionCallContext> {
  const resolution = await resolveCredential(sql, organizationId ?? "", "jev");
  return resolution.status === "ready" ? { typesafeKey: resolution.secret } : {};
}

export type DispatchedDecision = DecisionResult & {
  selection: EngineSelection;
  persisted: boolean;
};

export async function decideWithActiveEngine(input: {
  sql?: Sql;
  request: DecisionRequest;
  engines?: DecisionEngineRegistry;
  recordId?: string;
  /** The selection the caller already resolved, so a gate records the engine it actually called. */
  selection?: EngineSelection;
}): Promise<DispatchedDecision> {
  const engines = input.engines ?? createDecisionEngines();
  const selection = input.selection ?? (await resolveActiveEngine(input.sql, input.request.organizationId));
  const engine = engines[selection.engineId];
  if (!engine) {
    throw new Error(`No decision engine is registered for '${selection.engineId}'.`);
  }
  const context = selection.engineId === "jev" ? await jevCallContext(input.sql, input.request.organizationId) : undefined;
  const result = await engine.decide(input.request, context);
  const persisted = input.sql
    ? await persistDecisionLineage(input.sql, input.request, result, input.recordId)
    : false;
  return { ...result, selection, persisted };
}

export function registeredEngineIds(): readonly DecisionEngineId[] {
  return DECISION_ENGINE_IDS;
}
