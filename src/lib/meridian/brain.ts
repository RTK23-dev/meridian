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

export const BRAIN_FIELDS = [
  { key: "targetCustomers", column: "target_customers", label: "Target customers", group: "Audience" },
  { key: "problems", column: "problems", label: "Problems", group: "Audience" },
  { key: "desires", column: "desires", label: "Desires", group: "Audience" },
  { key: "objections", column: "objections", label: "Objections", group: "Audience" },
  { key: "positioning", column: "positioning", label: "Positioning", group: "Positioning" },
  { key: "differentiators", column: "differentiators", label: "Differentiators", group: "Positioning" },
  { key: "valueProposition", column: "value_proposition", label: "Value proposition", group: "Positioning" },
  { key: "tone", column: "tone", label: "Tone", group: "Voice" },
  { key: "personality", column: "personality", label: "Personality", group: "Voice" },
  { key: "writingStyle", column: "writing_style", label: "Writing style", group: "Voice" },
  { key: "wordsToUse", column: "words_to_use", label: "Words to use", group: "Voice" },
  { key: "wordsToAvoid", column: "words_to_avoid", label: "Words to avoid", group: "Voice" },
  { key: "preferredFormats", column: "preferred_formats", label: "Preferred formats", group: "Advertising" },
  { key: "preferredChannels", column: "preferred_channels", label: "Preferred channels", group: "Advertising" },
  { key: "requiredDisclaimers", column: "required_disclaimers", label: "Required disclaimers", group: "Compliance" },
  { key: "prohibitedClaims", column: "prohibited_claims", label: "Prohibited claims", group: "Compliance" },
  { key: "personas", column: "personas", label: "Personas", group: "Audience" },
  { key: "mission", column: "mission", label: "Mission", group: "Positioning" },
  { key: "objectives", column: "objectives", label: "Objectives", group: "Positioning" },
  { key: "proofPoints", column: "proof_points", label: "Proof points", group: "Positioning" },
  { key: "offers", column: "offers", label: "Offers", group: "Advertising" },
  { key: "colors", column: "colors", label: "Colors", group: "Visual" },
  { key: "typography", column: "typography", label: "Typography", group: "Visual" },
  { key: "imageryRules", column: "imagery_rules", label: "Imagery rules", group: "Visual" },
  { key: "forbiddenImagery", column: "forbidden_imagery", label: "Forbidden imagery", group: "Visual" },
  { key: "requiredClaims", column: "required_claims", label: "Required claims", group: "Compliance" },
] as const;

export type BrainKey = (typeof BRAIN_FIELDS)[number]["key"];

export type BrainValues = Record<BrainKey, string> & {
  automationLevel: AutomationLevel;
};

export type ProvenanceMap = Partial<Record<BrainKey, Provenance>>;

export function emptyBrain(): BrainValues {
  const brain: BrainValues = {
    automationLevel: "manual",
    targetCustomers: "",
    problems: "",
    desires: "",
    objections: "",
    positioning: "",
    differentiators: "",
    valueProposition: "",
    tone: "",
    personality: "",
    writingStyle: "",
    wordsToUse: "",
    wordsToAvoid: "",
    preferredFormats: "",
    preferredChannels: "",
    requiredDisclaimers: "",
    prohibitedClaims: "",
    personas: "",
    mission: "",
    objectives: "",
    proofPoints: "",
    offers: "",
    colors: "",
    typography: "",
    imageryRules: "",
    forbiddenImagery: "",
    requiredClaims: "",
  };
  return brain;
}

export function isProvenance(value: string): value is Provenance {
  return (PROVENANCE as readonly string[]).includes(value);
}

export function isAutomationLevel(value: string): value is AutomationLevel {
  return (AUTOMATION_LEVELS as readonly string[]).includes(value);
}

/** Share of brain fields the team has actually written. Empty is incomplete, not inferred. */
export function brainCompleteness(values: Record<BrainKey, string>): {
  filled: number;
  total: number;
  ratio: number;
} {
  const total: number = BRAIN_FIELDS.length;
  let filled = 0;
  for (const field of BRAIN_FIELDS) {
    if (values[field.key]?.trim()) filled += 1;
  }
  return { filled, total, ratio: total === 0 ? 0 : filled / total };
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
