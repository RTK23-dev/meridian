export const PROVENANCE = [
  "user_defined",
  "ai_inferred",
  "imported",
  "learned_from_performance",
  "learned_from_review",
] as const;

export type Provenance = (typeof PROVENANCE)[number];

export const AUTOMATION_LEVELS = [
  "manual",
  "assisted",
  "automated",
  "autonomous",
] as const;

export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

/** The brain screen's sections, in the order it shows them. Every brain field belongs to exactly one. */
export const BRAIN_SECTION_IDS = ["identity", "positioning", "audience", "voice", "rules", "assets"] as const;

export type BrainSectionId = (typeof BRAIN_SECTION_IDS)[number];

export const BRAIN_SECTION_LABELS: Record<BrainSectionId, string> = {
  identity: "Identity",
  positioning: "Positioning",
  audience: "Audience",
  voice: "Voice",
  rules: "Rules",
  assets: "Assets",
};

/**
 * The brain's fields. This is the one list the form, the completeness count, the save validation and the tests read.
 *
 * `section` is where the form shows the field. `required` is true only for a field that a generation or gate step reads
 * as its basis, with no fallback that could stand in for it:
 * - positioning: the opportunity and brief steps build their brand text from it, and the brief gate checks it.
 * - targetCustomers: the audience for opportunities, studio loops and briefs, when the opportunity names none.
 * - tone: passed to brief, image and creative checks as the voice the copy must hold.
 * - prohibitedClaims: the brief gate checks every brief against it. Empty, that check has no evidence and the brief goes to review.
 *
 * Every other field is optional. An empty optional field stays empty, and the brain can be complete without it.
 * `group` is the server-side grouping kept from earlier versions. The screen does not use it.
 */
export const BRAIN_FIELDS = [
  { key: "mission", column: "mission", label: "Mission", group: "Positioning", section: "identity", required: false },
  { key: "objectives", column: "objectives", label: "Objectives", group: "Positioning", section: "identity", required: false },
  { key: "positioning", column: "positioning", label: "Positioning", group: "Positioning", section: "positioning", required: true },
  { key: "differentiators", column: "differentiators", label: "Differentiators", group: "Positioning", section: "positioning", required: false },
  { key: "valueProposition", column: "value_proposition", label: "Value proposition", group: "Positioning", section: "positioning", required: false },
  { key: "proofPoints", column: "proof_points", label: "Proof points", group: "Positioning", section: "positioning", required: false },
  { key: "offers", column: "offers", label: "Offers", group: "Advertising", section: "positioning", required: false },
  { key: "targetCustomers", column: "target_customers", label: "Target customers", group: "Audience", section: "audience", required: true },
  { key: "personas", column: "personas", label: "Personas", group: "Audience", section: "audience", required: false },
  { key: "problems", column: "problems", label: "Problems", group: "Audience", section: "audience", required: false },
  { key: "desires", column: "desires", label: "Desires", group: "Audience", section: "audience", required: false },
  { key: "objections", column: "objections", label: "Objections", group: "Audience", section: "audience", required: false },
  { key: "tone", column: "tone", label: "Tone", group: "Voice", section: "voice", required: true },
  { key: "personality", column: "personality", label: "Personality", group: "Voice", section: "voice", required: false },
  { key: "writingStyle", column: "writing_style", label: "Writing style", group: "Voice", section: "voice", required: false },
  { key: "wordsToUse", column: "words_to_use", label: "Words to use", group: "Voice", section: "voice", required: false },
  { key: "wordsToAvoid", column: "words_to_avoid", label: "Words to avoid", group: "Voice", section: "voice", required: false },
  { key: "requiredDisclaimers", column: "required_disclaimers", label: "Required disclaimers", group: "Compliance", section: "rules", required: false },
  { key: "prohibitedClaims", column: "prohibited_claims", label: "Prohibited claims", group: "Compliance", section: "rules", required: true },
  { key: "requiredClaims", column: "required_claims", label: "Required claims", group: "Compliance", section: "rules", required: false },
  { key: "preferredFormats", column: "preferred_formats", label: "Preferred formats", group: "Advertising", section: "rules", required: false },
  { key: "preferredChannels", column: "preferred_channels", label: "Preferred channels", group: "Advertising", section: "rules", required: false },
  { key: "colors", column: "colors", label: "Colors", group: "Visual", section: "assets", required: false },
  { key: "typography", column: "typography", label: "Typography", group: "Visual", section: "assets", required: false },
  { key: "imageryRules", column: "imagery_rules", label: "Imagery rules", group: "Visual", section: "assets", required: false },
  { key: "forbiddenImagery", column: "forbidden_imagery", label: "Forbidden imagery", group: "Visual", section: "assets", required: false },
] as const;

export type BrainKey = (typeof BRAIN_FIELDS)[number]["key"];

export type BrainValues = Record<BrainKey, string> & {
  automationLevel: AutomationLevel;
};

export type ProvenanceMap = Partial<Record<BrainKey, Provenance>>;

/** Every key a brain value carries, including the automation preference. */
export const BRAIN_VALUE_KEYS: readonly (keyof BrainValues)[] = [...BRAIN_FIELDS.map((field) => field.key), "automationLevel"];

export const REQUIRED_BRAIN_KEYS: readonly BrainKey[] = BRAIN_FIELDS.filter((field) => field.required).map((field) => field.key);

export function brainFieldLabel(key: string): string | null {
  return BRAIN_FIELDS.find((field) => field.key === key)?.label ?? null;
}

export function emptyBrain(): BrainValues {
  const text = Object.fromEntries(BRAIN_FIELDS.map((field) => [field.key, ""])) as Record<BrainKey, string>;
  return { ...text, automationLevel: "manual" };
}

export function isProvenance(value: string): value is Provenance {
  return (PROVENANCE as readonly string[]).includes(value);
}

export function isAutomationLevel(value: string): value is AutomationLevel {
  return (AUTOMATION_LEVELS as readonly string[]).includes(value);
}

/** A brain with every text field trimmed, which is how the server stores it. Two brains are compared in this form. */
export function trimmedBrain(values: BrainValues): BrainValues {
  const trimmed = { ...values } as Record<string, string>;
  for (const key of BRAIN_VALUE_KEYS) trimmed[key] = (values[key] ?? "").trim();
  return trimmed as unknown as BrainValues;
}

/**
 * The fields whose trimmed value in `next` differs from `base`, with the value to send for each. A field that did not
 * change is left out, so a save never writes it. An empty result means nothing changed.
 */
export function brainChanges(next: BrainValues, base: BrainValues): Partial<BrainValues> {
  const changes: Record<string, string> = {};
  for (const key of BRAIN_VALUE_KEYS) {
    const value = (next[key] ?? "").trim();
    if (value !== (base[key] ?? "").trim()) changes[key] = value;
  }
  return changes as Partial<BrainValues>;
}

/**
 * Brings a form up to a newer saved brain without losing the person's edits. A field the form still holds as it was in
 * `previous` takes the `next` value. A field the person changed keeps the form's value, until a save sends it.
 */
export function reconcileBrain(form: BrainValues, previous: BrainValues, next: BrainValues): BrainValues {
  const merged: Record<string, string> = { ...form };
  for (const key of BRAIN_VALUE_KEYS) {
    if ((form[key] ?? "").trim() === (previous[key] ?? "").trim()) merged[key] = (next[key] ?? "").trim();
  }
  return merged as unknown as BrainValues;
}

export type BrainCompleteness = {
  /** Every brain field with content, required or not. */
  filled: number;
  total: number;
  ratio: number;
  /** The required fields with content, and how many there are. */
  requiredFilled: number;
  requiredTotal: number;
  /** True only when every required field has content. */
  requiredComplete: boolean;
  /** The required fields still empty, in the order the form shows them. */
  missingRequired: BrainKey[];
};

/** Counts the brain. Empty is incomplete, not inferred. Whitespace-only counts as empty. */
export function brainCompleteness(values: Record<BrainKey, string>): BrainCompleteness {
  const total: number = BRAIN_FIELDS.length;
  const hasContent = (key: BrainKey) => (values[key] ?? "").trim().length > 0;
  const filled = BRAIN_FIELDS.filter((field) => hasContent(field.key)).length;
  const missingRequired = REQUIRED_BRAIN_KEYS.filter((key) => !hasContent(key));
  const requiredTotal = REQUIRED_BRAIN_KEYS.length;
  return {
    filled,
    total,
    ratio: total === 0 ? 0 : filled / total,
    requiredFilled: requiredTotal - missingRequired.length,
    requiredTotal,
    requiredComplete: missingRequired.length === 0,
    missingRequired,
  };
}

export function provenanceLabel(value: Provenance): string {
  switch (value) {
    case "user_defined":
      return "Written by you";
    case "ai_inferred":
      return "Suggested, not confirmed";
    case "imported":
      return "Imported";
    case "learned_from_performance":
      return "Learned from results";
    case "learned_from_review":
      return "Learned from review";
  }
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base || "workspace";
}
