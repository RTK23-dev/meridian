/**
 * The transport JEV decisions use for one workspace. JEV's question registry, evidence rules, answer validation and abstentions
 * are the same whichever service answers. This setting chooses only that service.
 *
 *   typesafe_direct  TypeSafe System One, with the workspace's TypeSafe key. The default when a workspace has no row.
 *   openrouter       OpenRouter's Decisions API, with the workspace's OpenRouter key and its selected decision model.
 *
 * Every query is scoped to one organization. A stored value that is not a known backend is never guessed at: it is reported.
 */
import type { Sql } from "../learning/store.ts";
import { loadDefaultSql } from "../credentials/resolve.ts";

export const JEV_BACKENDS = ["typesafe_direct", "openrouter"] as const;
export type JevBackend = (typeof JEV_BACKENDS)[number];
export const DEFAULT_JEV_BACKEND: JevBackend = "typesafe_direct";
export const JEV_BACKEND_LABELS: Record<JevBackend, string> = {
  typesafe_direct: "TypeSafe System One",
  openrouter: "OpenRouter Decisions",
};

export function isJevBackend(value: unknown): value is JevBackend {
  return typeof value === "string" && (JEV_BACKENDS as readonly string[]).includes(value);
}

/** A stored backend, or `null` when the workspace has never chosen one (the default applies). */
export type JevBackendReadResult = { ok: true; backend: JevBackend | null } | { ok: false; reason: string };

/** How a JEV decision finds its backend. A failure to read it is reported, and nothing else is tried in its place. */
export interface JevBackendStore {
  read(organizationId: string): Promise<JevBackendReadResult>;
}

export async function readJevBackend(sql: Sql, organizationId: string): Promise<JevBackendReadResult> {
  const rows = await sql<{ backend: string }>`
    select backend from decision_engine_jev_config where organization_id = ${organizationId} limit 1
  `;
  const value = rows[0]?.backend;
  if (value === undefined) return { ok: true, backend: null };
  if (!isJevBackend(value)) return { ok: false, reason: `The stored JEV backend '${value}' is not a known backend.` };
  return { ok: true, backend: value };
}

/** Saves the workspace's JEV backend, with an audit entry. The caller checks the backend is known and READY. */
export async function writeJevBackend(
  sql: Sql,
  input: { organizationId: string; actorId: string; backend: JevBackend },
): Promise<void> {
  await sql`
    insert into decision_engine_jev_config (organization_id, backend, updated_by, updated_at)
    values (${input.organizationId}, ${input.backend}, ${input.actorId}, now())
    on conflict (organization_id) do update
      set backend = excluded.backend, updated_by = excluded.updated_by, updated_at = now()
  `;
  await sql`
    insert into audit_log (id, organization_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.actorId}, 'decision_engine.jev_backend.update',
      'decision_engine', 'jev', ${JSON.stringify({ backend: input.backend })}
    )
  `;
}

/** The backend store the engine uses by default: the database, read through the default connection for each decision. */
export const databaseJevBackendStore: JevBackendStore = {
  async read(organizationId) {
    try {
      return await readJevBackend(await loadDefaultSql(), organizationId);
    } catch {
      return { ok: false, reason: "The JEV backend setting could not be read, so JEV made no request." };
    }
  },
};
