import { BRAIN_FIELDS, type BrainKey } from "@/lib/meridian/brain";

/**
 * The brain form's sections. The server keeps its own field groups (BRAIN_FIELDS.group); this mapping
 * only decides where each field is shown. Every field must appear in exactly one section.
 * automationLevel is not a text field, so it is not listed here. The Rules section adds it as a control.
 */
export type BrainSectionId = "identity" | "positioning" | "audience" | "voice" | "rules" | "assets";

export const BRAIN_SECTIONS: ReadonlyArray<{ id: BrainSectionId; label: string; keys: readonly BrainKey[] }> = [
  { id: "identity", label: "Identity", keys: ["mission", "objectives"] },
  { id: "positioning", label: "Positioning", keys: ["positioning", "differentiators", "valueProposition", "proofPoints", "offers"] },
  { id: "audience", label: "Audience", keys: ["targetCustomers", "personas", "problems", "desires", "objections"] },
  { id: "voice", label: "Voice", keys: ["tone", "personality", "writingStyle", "wordsToUse", "wordsToAvoid"] },
  { id: "rules", label: "Rules", keys: ["requiredDisclaimers", "prohibitedClaims", "requiredClaims", "preferredFormats", "preferredChannels"] },
  { id: "assets", label: "Assets", keys: ["colors", "typography", "imageryRules", "forbiddenImagery"] },
];

export function sectionAnchor(id: BrainSectionId): string {
  return `brain-${id}`;
}

export function fieldLabel(key: string): string | null {
  return BRAIN_FIELDS.find((field) => field.key === key)?.label ?? null;
}

/** Fields that no section shows. Must be empty. */
export function unplacedFields(): BrainKey[] {
  const placed = new Set<string>(BRAIN_SECTIONS.flatMap((section) => section.keys));
  return BRAIN_FIELDS.map((field) => field.key).filter((key) => !placed.has(key));
}

/** Fields that two sections both show. Must be empty. */
export function duplicatedFields(): BrainKey[] {
  const seen = new Map<string, number>();
  for (const section of BRAIN_SECTIONS) {
    for (const key of section.keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key as BrainKey);
}

/** Filled and total text fields for one section. Whitespace-only counts as empty. */
export function sectionProgress(keys: readonly BrainKey[], values: Partial<Record<BrainKey, string>>): { filled: number; total: number } {
  const filled = keys.filter((key) => (values[key] ?? "").trim().length > 0).length;
  return { filled, total: keys.length };
}
