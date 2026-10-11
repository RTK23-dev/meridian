import { BRAIN_FIELDS, BRAIN_SECTION_IDS, BRAIN_SECTION_LABELS, brainFieldLabel, type BrainKey, type BrainSectionId } from "../../lib/meridian/brain.ts";

export type { BrainSectionId };

/**
 * The brain form's sections, derived from the field list. A field's `section` in BRAIN_FIELDS is the only place that
 * decides where it is shown, so a field cannot be missing from the form or shown twice. automationLevel is not a text
 * field, so it is not listed here. The Rules section adds it as a control.
 */
export const BRAIN_SECTIONS: ReadonlyArray<{ id: BrainSectionId; label: string; keys: readonly BrainKey[] }> = BRAIN_SECTION_IDS.map((id) => ({
  id,
  label: BRAIN_SECTION_LABELS[id],
  keys: BRAIN_FIELDS.filter((field) => field.section === id).map((field) => field.key),
}));

export function sectionAnchor(id: BrainSectionId): string {
  return `brain-${id}`;
}

export function fieldLabel(key: string): string | null {
  return brainFieldLabel(key);
}

/** Filled and total fields for one section. Whitespace-only counts as empty. */
export function sectionProgress(keys: readonly BrainKey[], values: Partial<Record<BrainKey, string>>): { filled: number; total: number } {
  const filled = keys.filter((key) => (values[key] ?? "").trim().length > 0).length;
  return { filled, total: keys.length };
}
