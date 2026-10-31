// The cookbook record of a content factory run (round 3, K13, decision D6). Written while the run is a draft, and fixed once it has started, so
// the research agents read the choice that actually made the run. Stored as JSON on the session (migration 0141).

import type { Sql } from "../learning/store.ts";
import type { SelectionRecord } from "./select.ts";

export type StoredSelection = SelectionRecord & { recordedAt: string };

/** Records the choice on a draft run. Returns false when the run is not a draft (already started, or not found): nothing is changed then. */
export async function recordCookbookSelection(
  sql: Sql,
  input: { organizationId: string; sessionId: string; record: SelectionRecord },
): Promise<boolean> {
  const payload: StoredSelection = { ...input.record, recordedAt: new Date().toISOString() };
  const rows = await sql<{ id: string }>`
    update content_factory_sessions set cookbook_selection = ${JSON.stringify(payload)}::jsonb, updated_at = now()
    where organization_id = ${input.organizationId} and id = ${input.sessionId} and status = 'draft'
    returning id
  `;
  return rows.length === 1;
}

/** The recorded choice of a run, or null when none was recorded. */
export async function cookbookSelectionOf(sql: Sql, input: { organizationId: string; sessionId: string }): Promise<StoredSelection | null> {
  const rows = await sql<{ cookbook_selection: unknown }>`
    select cookbook_selection from content_factory_sessions where organization_id = ${input.organizationId} and id = ${input.sessionId} limit 1
  `;
  const raw = rows[0]?.cookbook_selection;
  if (raw === null || raw === undefined) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as StoredSelection;
}
