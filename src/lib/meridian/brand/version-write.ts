/**
 * Brain version history. A Save appends a version. An autosave, which runs while someone types, replaces the newest version
 * only when that version is the same editor's own autosave. Otherwise it appends, so a Save and another person's edits are
 * never overwritten. Without this, every pause in typing added a row, and the history grew with the typing.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export const AUTOSAVE_NOTE = "Autosaved";
export const SAVE_NOTE = "Saved by a person";

export type NewestVersion = { note: string; createdBy: string } | null;

/** The pure rule. Autosave replaces only the same editor's newest autosave. Every other write appends. */
export function brainVersionAction(input: { autosave: boolean; editorId: string; newest: NewestVersion }): "append" | "replace" {
  if (!input.autosave || input.newest === null) return "append";
  return input.newest.note === AUTOSAVE_NOTE && input.newest.createdBy === input.editorId ? "replace" : "append";
}

/**
 * Writes the version row for one brain save, and reports whether it appended or replaced. The replaced row takes the new
 * version number and time, so the newest entry always shows the latest autosave.
 */
export async function writeBrainVersion(
  sql: Sql,
  input: { brandId: string; editorId: string; autosave: boolean; version: number; snapshot: string },
): Promise<"append" | "replace"> {
  const newestRows = await sql<{ id: string; note: string; created_by: string }>`
    select id, note, created_by from brand_brain_versions
    where brand_id = ${input.brandId}
    order by version desc
    limit 1
  `;
  const newest = newestRows[0];
  const action = brainVersionAction({
    autosave: input.autosave,
    editorId: input.editorId,
    newest: newest ? { note: newest.note, createdBy: newest.created_by } : null,
  });
  if (action === "replace" && newest) {
    await sql`
      update brand_brain_versions
      set version = ${input.version}, snapshot = ${input.snapshot}, note = ${AUTOSAVE_NOTE}, created_by = ${input.editorId}, created_at = now()
      where id = ${newest.id}
    `;
    return "replace";
  }
  await sql`
    insert into brand_brain_versions (id, brand_id, version, snapshot, note, created_by)
    values (${randomUUID()}, ${input.brandId}, ${input.version}, ${input.snapshot}, ${input.autosave ? AUTOSAVE_NOTE : SAVE_NOTE}, ${input.editorId})
  `;
  return "append";
}
