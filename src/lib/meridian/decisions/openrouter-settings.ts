/**
 * Stored settings and connection-check results for the OpenRouter Decisions engine.
 *
 * They live in their own tables, not in `decision_engine_settings`. Choosing or changing the decision model does not change the
 * active engine, and a connection check records what happened without changing any product data or the active engine. Every
 * query is scoped to one organization, so one workspace's model and check results are never read for another.
 */
import type { Sql } from "../learning/store.ts";

export const OPENROUTER_DECISIONS_ENGINE_ID = "openrouter-decisions";

export type OpenRouterCheckRecord = {
  status: "passed" | "failed";
  model: string;
  /** The masked fingerprint of the key the check used. A key change makes an earlier pass stop counting. */
  keyFingerprint: string;
  message: string;
  checkedAt: string;
  returnedModel: string | null;
  upstreamProvider: string | null;
  providerRequestId: string | null;
};

export async function readOpenRouterModel(sql: Sql, organizationId: string): Promise<string | null> {
  const rows = await sql<{ model: string }>`
    select model from decision_engine_openrouter_config where organization_id = ${organizationId} limit 1
  `;
  return rows[0]?.model ?? null;
}

/** Saves the workspace's OpenRouter decision model. The model is validated by the caller. The audit entry holds the model, never a key. */
export async function writeOpenRouterModel(
  sql: Sql,
  input: { organizationId: string; actorId: string; model: string },
): Promise<void> {
  await sql`
    insert into decision_engine_openrouter_config (organization_id, model, updated_by, updated_at)
    values (${input.organizationId}, ${input.model}, ${input.actorId}, now())
    on conflict (organization_id) do update
      set model = excluded.model, updated_by = excluded.updated_by, updated_at = now()
  `;
  await sql`
    insert into audit_log (id, organization_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.actorId}, 'decision_engine.openrouter_model.update',
      'decision_engine', ${OPENROUTER_DECISIONS_ENGINE_ID}, ${JSON.stringify({ model: input.model })}
    )
  `;
}

export async function readLatestOpenRouterCheck(sql: Sql, organizationId: string): Promise<OpenRouterCheckRecord | null> {
  const rows = await sql<{
    status: string;
    model: string;
    key_fingerprint: string;
    message: string;
    checked_at: Date | string;
    returned_model: string | null;
    upstream_provider: string | null;
    provider_request_id: string | null;
  }>`
    select status, model, key_fingerprint, message, checked_at, returned_model, upstream_provider, provider_request_id
    from decision_engine_checks
    where organization_id = ${organizationId} and engine_id = ${OPENROUTER_DECISIONS_ENGINE_ID}
    order by checked_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row || (row.status !== "passed" && row.status !== "failed")) return null;
  return {
    status: row.status,
    model: row.model,
    keyFingerprint: row.key_fingerprint,
    message: row.message,
    checkedAt: new Date(row.checked_at).toISOString(),
    returnedModel: row.returned_model,
    upstreamProvider: row.upstream_provider,
    providerRequestId: row.provider_request_id,
  };
}

/** Records one explicit connection check. It is an audit row for the check, not a change to any setting or product record. */
export async function recordOpenRouterCheck(
  sql: Sql,
  input: { organizationId: string; actorId: string; check: Omit<OpenRouterCheckRecord, "checkedAt"> },
): Promise<void> {
  const { check } = input;
  await sql`
    insert into decision_engine_checks (
      id, organization_id, engine_id, model, key_fingerprint, status, message,
      returned_model, upstream_provider, provider_request_id, actor_id, checked_at
    )
    values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${OPENROUTER_DECISIONS_ENGINE_ID}, ${check.model},
      ${check.keyFingerprint}, ${check.status}, ${check.message}, ${check.returnedModel}, ${check.upstreamProvider},
      ${check.providerRequestId}, ${input.actorId}, now()
    )
  `;
  await sql`
    insert into audit_log (id, organization_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.actorId}, 'decision_engine.openrouter_check',
      'decision_engine', ${OPENROUTER_DECISIONS_ENGINE_ID},
      ${JSON.stringify({ status: check.status, model: check.model, returnedModel: check.returnedModel })}
    )
  `;
}
