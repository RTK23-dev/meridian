/**
 * Active decision-engine selection.
 *
 * Exactly one engine is active for an organization, and only that engine receives normal decision requests.
 *
 * Precedence: the workspace setting in `decision_engine_settings` (per organization, so one tenant's choice never
 * applies to another), then the deployment default `DECISION_ENGINE`, then `jev`, which is the engine that already
 * ran before this change. An invalid deployment value is ignored and reported, not guessed at.
 *
 * Switching is refused unless the target engine reports READY. The previous valid selection is kept, and nothing
 * switches silently when the active engine later fails.
 */
import type { Sql } from "../learning/store.ts";
import { isDecisionEngineId, type DecisionEngineId } from "./types.ts";

export const DECISION_ENGINE_ENV = "DECISION_ENGINE";
export const DEFAULT_DECISION_ENGINE: DecisionEngineId = "jev";

export type DecisionEngineSource = "workspace" | "deployment" | "default";

export type EngineSelection = {
  engineId: DecisionEngineId;
  source: DecisionEngineSource;
  /** Set when DECISION_ENGINE holds a value that is not an engine id. The default is used and this says so. */
  invalidDeploymentValue?: string;
};

export function parseDeploymentEngine(raw: string | undefined): { engineId?: DecisionEngineId; invalid?: string } {
  const value = raw?.trim().toLowerCase();
  if (!value) return {};
  if (isDecisionEngineId(value)) return { engineId: value };
  return { invalid: raw!.trim() };
}

/** Pure precedence rule, so the policy can be tested without a database. */
export function resolveEngineSelection(input: {
  workspace?: DecisionEngineId | null;
  deploymentValue?: string;
}): EngineSelection {
  if (input.workspace && isDecisionEngineId(input.workspace)) {
    return { engineId: input.workspace, source: "workspace" };
  }
  const deployment = parseDeploymentEngine(input.deploymentValue);
  if (deployment.engineId) return { engineId: deployment.engineId, source: "deployment" };
  return {
    engineId: DEFAULT_DECISION_ENGINE,
    source: "default",
    ...(deployment.invalid ? { invalidDeploymentValue: deployment.invalid } : {}),
  };
}

export async function readWorkspaceEngine(sql: Sql, organizationId: string): Promise<DecisionEngineId | null> {
  const rows = await sql<{ engine_id: string }>`
    select engine_id from decision_engine_settings where organization_id = ${organizationId} limit 1
  `;
  const value = rows[0]?.engine_id;
  return value && isDecisionEngineId(value) ? value : null;
}

/** The engine that will receive this organization's decisions. Without a database, the deployment rule applies. */
export async function resolveActiveEngine(sql: Sql | undefined, organizationId: string | undefined): Promise<EngineSelection> {
  const deploymentValue = process.env[DECISION_ENGINE_ENV];
  if (!sql || !organizationId) return resolveEngineSelection({ deploymentValue });
  const workspace = await readWorkspaceEngine(sql, organizationId);
  return resolveEngineSelection({ workspace, deploymentValue });
}

export type SaveEngineResult =
  | { ok: true; engineId: DecisionEngineId; previous: EngineSelection }
  | { ok: false; reason: string; previous: EngineSelection };

/**
 * Saves the workspace engine after the target engine reports READY. Refusals keep the current selection and say why.
 * The change is written to the audit log with the previous and new engine, never a credential.
 */
export async function saveWorkspaceEngine(
  sql: Sql,
  input: {
    organizationId: string;
    actorId: string;
    engineId: string;
    /** Health of the target engine, resolved by the caller so this module stays independent of the adapters. */
    targetHealth: { status: string; message?: string };
  },
): Promise<SaveEngineResult> {
  const previous = await resolveActiveEngine(sql, input.organizationId);
  if (!isDecisionEngineId(input.engineId)) {
    return { ok: false, reason: `'${input.engineId}' is not a decision engine.`, previous };
  }
  if (input.targetHealth.status !== "READY") {
    return {
      ok: false,
      reason: input.targetHealth.message ?? `${input.engineId} is not READY.`,
      previous,
    };
  }
  await sql`
    insert into decision_engine_settings (organization_id, engine_id, updated_by, updated_at)
    values (${input.organizationId}, ${input.engineId}, ${input.actorId}, now())
    on conflict (organization_id) do update
      set engine_id = excluded.engine_id, updated_by = excluded.updated_by, updated_at = now()
  `;
  await sql`
    insert into audit_log (id, organization_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.actorId}, 'decision_engine.update',
      'decision_engine', 'active',
      ${JSON.stringify({ from: previous.engineId, to: input.engineId, fromSource: previous.source })}
    )
  `;
  return { ok: true, engineId: input.engineId, previous };
}
