/**
 * Stored reads and writes for the brand brain, free of server-function wiring so the save path can be tested against a
 * database. Every write checks the caller's role first. A save writes only the fields it was given, so a field the person
 * did not change is never replaced by a value that was on screen earlier. The resume record is written with the same calls.
 *
 * Imports are relative on purpose: node loads this module directly in tests, and it cannot resolve the `@/` alias.
 */
import type { Sql } from "../learning/store.ts";
import { assertRole, isRole, type Role } from "../access.ts";
import {
  BRAIN_FIELDS,
  BRAIN_SECTION_IDS,
  emptyBrain,
  isAutomationLevel,
  isProvenance,
  type BrainKey,
  type BrainSectionId,
  type BrainValues,
  type ProvenanceMap,
} from "../brain.ts";
import { brainValuesSchema } from "../schemas/brain.ts";
import { writeBrainVersion } from "./version-write.ts";

export type BrainProgress = {
  section: BrainSectionId | null;
  touchedFields: BrainKey[];
  updatedAt: string | null;
};

export type BrainSave = {
  organizationId: string;
  version: number;
  brain: BrainValues;
  /** The fields this save changed. Fields that were sent unchanged are not listed. */
  touched: BrainKey[];
};

const brainChangesSchema = brainValuesSchema.partial().strict();

/** The fields a save carries. Only the keys present are written. An unknown key or an invalid value is refused. */
export function parseBrainChanges(raw: unknown): Partial<BrainValues> {
  if (raw === undefined || raw === null) return {};
  const parsed = brainChangesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "A field cannot be saved as entered.");
  return parsed.data as Partial<BrainValues>;
}

/** The section a save or a visit was in. Empty means none was given, so the stored section is kept. */
export function parseBrainSection(raw: unknown): BrainSectionId | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && (BRAIN_SECTION_IDS as readonly string[]).includes(raw)) return raw as BrainSectionId;
  throw new Error("Unknown brain section.");
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function storedProvenance(value: unknown): ProvenanceMap {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  const provenance: ProvenanceMap = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return provenance;
  for (const field of BRAIN_FIELDS) {
    const entry = (parsed as Record<string, unknown>)[field.key];
    if (typeof entry === "string" && isProvenance(entry)) provenance[field.key] = entry;
  }
  return provenance;
}

type StoredBrain = { brain: BrainValues; provenance: ProvenanceMap; version: number };

/** The brain as stored. A brand with no brain row yet reads as an empty brain at version 0. */
function storedBrain(row: Record<string, unknown> | undefined): StoredBrain {
  const brain = emptyBrain();
  if (!row) return { brain, provenance: {}, version: 0 };
  for (const field of BRAIN_FIELDS) brain[field.key] = text(row[field.column]);
  const level = text(row.automation_level);
  brain.automationLevel = isAutomationLevel(level) ? level : "manual";
  const version = Number(row.version);
  return { brain, provenance: storedProvenance(row.provenance), version: Number.isFinite(version) ? version : 1 };
}

function storedTouched(value: unknown): BrainKey[] {
  let parsed: unknown = [];
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const known = new Set<string>(BRAIN_FIELDS.map((field) => field.key));
  const keys = parsed.filter((item): item is BrainKey => typeof item === "string" && known.has(item));
  return [...new Set(keys)];
}

/**
 * The write check. The brand must exist and not be deleted, the caller must belong to its workspace, and the role must be
 * member or above. Viewers are refused here, before anything is read or written.
 */
export async function assertCanWriteBrain(sql: Sql, userId: string, brandId: string): Promise<{ organizationId: string; role: Role }> {
  const brands = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = brands[0]?.organization_id;
  if (!organizationId) throw new Error("Brand not found.");
  const memberships = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = memberships[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, "member");
  return { organizationId, role };
}

/** Where the person left off in this brand's brain. Empty when nothing has been recorded. */
export async function readBrainProgress(sql: Sql, brandId: string): Promise<BrainProgress> {
  const rows = await sql<Record<string, unknown>>`
    select current_section, touched_fields, updated_at from brand_brain_progress where brand_id = ${brandId} limit 1
  `;
  const row = rows[0];
  if (!row) return { section: null, touchedFields: [], updatedAt: null };
  const section = (BRAIN_SECTION_IDS as readonly string[]).includes(text(row.current_section))
    ? (text(row.current_section) as BrainSectionId)
    : null;
  return {
    section,
    touchedFields: storedTouched(row.touched_fields),
    updatedAt: row.updated_at == null ? null : text(row.updated_at),
  };
}

/** Writes the resume record. A null section keeps the stored one. The touched fields are added to the stored list. */
async function writeBrainProgress(
  sql: Sql,
  input: { brandId: string; actorId: string; section: BrainSectionId | null; touched: BrainKey[] },
): Promise<void> {
  const existing = await readBrainProgress(sql, input.brandId);
  const section = input.section ?? existing.section;
  const touched = [...new Set<BrainKey>([...existing.touchedFields, ...input.touched])];
  await sql`
    insert into brand_brain_progress (brand_id, current_section, touched_fields, updated_by, updated_at)
    values (${input.brandId}, ${section ?? ""}, ${JSON.stringify(touched)}, ${input.actorId}, now())
    on conflict (brand_id) do update set
      current_section = excluded.current_section,
      touched_fields = excluded.touched_fields,
      updated_by = excluded.updated_by,
      updated_at = now()
  `;
}

/** Records the section the person is in, so the brain opens there next time. Writes nothing to the brain itself. */
export async function recordBrainSection(sql: Sql, input: { brandId: string; actorId: string; section: unknown }): Promise<BrainProgress> {
  const section = parseBrainSection(input.section);
  if (!section) throw new Error("Unknown brain section.");
  await assertCanWriteBrain(sql, input.actorId, input.brandId);
  await writeBrainProgress(sql, { brandId: input.brandId, actorId: input.actorId, section, touched: [] });
  return readBrainProgress(sql, input.brandId);
}

/**
 * Saves the fields in `changes` and nothing else. Each save appends a version row with the full brain as it now stands,
 * through the same version rule the screen always used (autosave replaces the editor's own newest autosave; a save appends).
 */
export async function saveBrainChanges(
  sql: Sql,
  input: { brandId: string; actorId: string; changes: unknown; autosave: boolean; section: unknown },
): Promise<BrainSave> {
  const changes = parseBrainChanges(input.changes);
  const section = parseBrainSection(input.section);
  const { organizationId } = await assertCanWriteBrain(sql, input.actorId, input.brandId);

  const currentRows = await sql.query<Record<string, unknown>>(
    `select ${BRAIN_FIELDS.map((field) => field.column).join(", ")}, automation_level, provenance, version
     from brand_brains where brand_id = $1 limit 1`,
    [input.brandId],
  );
  const hasRow = currentRows.length > 0;
  const current = storedBrain(currentRows[0]);
  const next: BrainValues = { ...current.brain, ...changes };

  // A key counts as edited only when its value differs from the stored one, so a value sent unchanged is not written.
  const editedKeys = (Object.keys(changes) as (keyof BrainValues)[]).filter((key) => next[key] !== current.brain[key]);
  const editedFields = BRAIN_FIELDS.filter((field) => editedKeys.includes(field.key));
  const automationEdited = editedKeys.includes("automationLevel");
  const provenance: ProvenanceMap = { ...current.provenance };
  for (const field of editedFields) provenance[field.key] = "user_defined";
  const version = Math.max(current.version, 0) + 1;

  if (!hasRow) {
    const count = BRAIN_FIELDS.length;
    await sql.query(
      `insert into brand_brains (
         brand_id, ${BRAIN_FIELDS.map((field) => field.column).join(", ")},
         automation_level, provenance, version, updated_by
       ) values (
         $1, ${BRAIN_FIELDS.map((_, index) => `$${index + 2}`).join(", ")},
         $${count + 2}, $${count + 3}, $${count + 4}, $${count + 5}
       )`,
      [input.brandId, ...BRAIN_FIELDS.map((field) => next[field.key]), next.automationLevel, JSON.stringify(provenance), version, input.actorId],
    );
  } else {
    // Only the edited columns are named in the update. Two saves that touch different fields cannot undo each other.
    const params: unknown[] = [];
    const sets: string[] = [];
    for (const field of editedFields) {
      params.push(next[field.key]);
      sets.push(`${field.column} = $${params.length}`);
    }
    if (automationEdited) {
      params.push(next.automationLevel);
      sets.push(`automation_level = $${params.length}`);
    }
    params.push(JSON.stringify(provenance));
    sets.push(`provenance = $${params.length}`);
    params.push(version);
    sets.push(`version = $${params.length}`);
    params.push(input.actorId);
    sets.push(`updated_by = $${params.length}`);
    sets.push("updated_at = now()");
    params.push(input.brandId);
    await sql.query(`update brand_brains set ${sets.join(", ")} where brand_id = $${params.length}`, params);
  }

  await writeBrainVersion(sql, {
    brandId: input.brandId,
    editorId: input.actorId,
    autosave: input.autosave,
    version,
    snapshot: JSON.stringify({ brain: next, provenance }),
  });
  await writeBrainProgress(sql, {
    brandId: input.brandId,
    actorId: input.actorId,
    section,
    touched: editedFields.map((field) => field.key),
  });
  await sql`update brands set updated_at = now() where id = ${input.brandId}`;
  return { organizationId, version, brain: next, touched: editedFields.map((field) => field.key) };
}
