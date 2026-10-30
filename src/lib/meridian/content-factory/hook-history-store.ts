// The started videos of one brand, each with the hook of the script its run was made from (hook-history.ts). The script is read from the
// engine's own artifacts: the written script when the engine wrote one, otherwise the script lines the person sent. A draft session has no
// run and is not read. Every query is scoped to the workspace and the brand.

import type { Sql } from "../learning/store.ts";
import { hookOfBeats } from "./hook-history.ts";

export type StartedHook = { sessionId: string; title: string; startedAt: string | null; hook: string | null };

type Beat = { role: string; text: string };

function jsonOf(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** The beats of an artifact body: a written script keeps them at the top; a request keeps the person's script under `script`. */
function beatsOf(body: unknown, field: "beats" | "script"): Beat[] {
  const parsed = jsonOf(body);
  if (parsed === null || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const list = field === "beats" ? record.beats : (record.script as Record<string, unknown> | undefined)?.beats;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): Beat[] => {
    if (item === null || typeof item !== "object") return [];
    const beat = item as Record<string, unknown>;
    return typeof beat.role === "string" && typeof beat.text === "string" ? [{ role: beat.role, text: beat.text }] : [];
  });
}

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function readStartedHooks(sql: Sql, organizationId: string, brandId: string): Promise<StartedHook[]> {
  const rows = await sql<{ session_id: string; title: string; started_at: unknown; written: unknown; requested: unknown }>`
    select s.id as session_id, s.title, s.started_at,
      (select a.body from engine_artifacts a
        where a.organization_id = s.organization_id and a.request_id = s.engine_request_id and a.type = 'written_script'
        order by a.created_at desc limit 1) as written,
      (select a.body from engine_artifacts a
        where a.organization_id = s.organization_id and a.request_id = s.engine_request_id and a.type = 'production_request'
        order by a.created_at desc limit 1) as requested
    from content_factory_sessions s
    where s.organization_id = ${organizationId} and s.brand_id = ${brandId} and s.status = 'started' and not s.demo
    order by s.started_at desc nulls last, s.id
  `;
  return rows.map((row) => ({
    sessionId: row.session_id,
    title: row.title,
    startedAt: isoOf(row.started_at),
    hook: hookOfBeats(beatsOf(row.written, "beats")) ?? hookOfBeats(beatsOf(row.requested, "script")),
  }));
}
