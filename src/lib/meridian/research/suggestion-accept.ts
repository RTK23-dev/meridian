/**
 * Accepting a brain suggestion. The brain changes only through the brand brain save path (brand/brain-store.ts), so an
 * accepted suggestion is a save of one field. It is change-only and writes a version row, like any other save, and it gets the
 * same role check and provenance. A suggestion whose value the brain already holds changes nothing: it is marked accepted and
 * no version is written.
 *
 * Imports are relative on purpose: node loads this module directly in tests, and it cannot resolve the `@/` alias.
 */
import type { Sql } from "../learning/store.ts";
import { BRAIN_FIELDS, type BrainKey } from "../brain.ts";
import { saveBrainChanges } from "../brand/brain-store.ts";

export type SuggestionAcceptance = {
  field: BrainKey;
  /** False when the brain already held the suggested value, so nothing was written. */
  changed: boolean;
  /** The brain version the save wrote. Null when nothing changed. */
  version: number | null;
};

/** Accepts one pending suggestion for a brand. Throws when it is not pending, or when the caller cannot write the brain. */
export async function acceptBrainSuggestion(
  sql: Sql,
  input: { organizationId: string; brandId: string; suggestionId: string; actorId: string },
): Promise<SuggestionAcceptance> {
  const rows = await sql<{ field_key: string; proposed_value: string }>`
    select field_key, proposed_value from brain_suggestions
    where id = ${input.suggestionId} and brand_id = ${input.brandId}
      and organization_id = ${input.organizationId} and status = 'pending'
    limit 1
  `;
  const suggestion = rows[0];
  if (!suggestion) throw new Error("That suggestion is not pending.");
  const field = BRAIN_FIELDS.find((entry) => entry.key === suggestion.field_key);
  if (!field) throw new Error("Unknown brain field.");

  const current = await sql.query<Record<string, unknown>>(
    `select ${field.column} from brand_brains where brand_id = $1 limit 1`,
    [input.brandId],
  );
  const stored = current[0] ? String(current[0][field.column] ?? "") : "";
  if (stored === suggestion.proposed_value) {
    await sql`update brain_suggestions set status = 'accepted' where id = ${input.suggestionId}`;
    return { field: field.key, changed: false, version: null };
  }

  const saved = await saveBrainChanges(sql, {
    brandId: input.brandId,
    actorId: input.actorId,
    changes: { [field.key]: suggestion.proposed_value },
    autosave: false,
    section: null,
  });
  await sql`update brain_suggestions set status = 'accepted' where id = ${input.suggestionId}`;
  return { field: field.key, changed: true, version: saved.version };
}
