// The brand frame of a brief: the constraints the brief was written under, each with its value and where it came from (prompt 14). Every
// field is explicit. A value the brand does not hold is "not set", never a guess, and it is shown as not set. Pure: the database and the
// server functions are elsewhere.
//
// The copy of a brief (audience, hook, message, offer, call to action) is judged by the brief gate as written, so it is not edited here.
// The frame holds what the gate does not judge: the claims and disclaimers the brand carries, the platform, the budget, the references and
// the success criteria. A person edits the editable part; the brand's own values are read as the brand has them.

export const FRAME_SOURCES = ["brand brain", "product", "research", "person", "not set"] as const;
export type FrameSource = (typeof FRAME_SOURCES)[number];

export type FrameField<T> = { value: T | null; source: FrameSource };

export type BriefFrame = {
  voice: FrameField<string>;
  prohibitedClaims: FrameField<string>;
  requiredDisclaimers: FrameField<string>;
  allowedClaims: FrameField<string>;
  platform: FrameField<string>;
  budgetUsd: FrameField<number>;
  visualReferences: FrameField<string[]>;
  successCriteria: FrameField<string>;
};

/** The fields a person may edit. The rest are read as the brand or the product holds them. */
export const EDITABLE_FRAME_FIELDS = ["platform", "budgetUsd", "visualReferences", "successCriteria"] as const;
export type EditableFrameField = (typeof EDITABLE_FRAME_FIELDS)[number];

export const PLATFORM_MAX = 120;
export const SUCCESS_MAX = 500;
export const REFERENCE_MAX = 300;
export const REFERENCES_MAX = 10;
export const BUDGET_MAX_USD = 100_000;

const notSet = <T>(): FrameField<T> => ({ value: null, source: "not set" });

function textOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The frame a new brief starts with: the brand's own values, the product's allowed claims, and nothing else set. */
export function frameFromBrand(input: { tone: string; prohibitedClaims: string; requiredDisclaimers: string; productAllowedClaims: string | null }): BriefFrame {
  const field = (value: string | undefined, source: FrameSource): FrameField<string> => {
    const text = textOrNull(value);
    return text === null ? notSet() : { value: text, source };
  };
  return {
    voice: field(input.tone, "brand brain"),
    prohibitedClaims: field(input.prohibitedClaims, "brand brain"),
    requiredDisclaimers: field(input.requiredDisclaimers, "brand brain"),
    allowedClaims: input.productAllowedClaims === null ? notSet() : field(input.productAllowedClaims, "product"),
    platform: notSet(),
    budgetUsd: notSet(),
    visualReferences: notSet(),
    successCriteria: notSet(),
  };
}

export type FrameEdit = {
  platform?: string | null;
  budgetUsd?: number | null;
  visualReferences?: string[] | null;
  successCriteria?: string | null;
};

/** Checks an edit and returns the first problem in plain words, or null. An edit names only the fields it changes. */
export function frameEditProblem(edit: FrameEdit): string | null {
  if (edit.platform !== undefined && edit.platform !== null && edit.platform.trim().length > PLATFORM_MAX) {
    return `The platform is longer than ${PLATFORM_MAX} characters.`;
  }
  if (edit.budgetUsd !== undefined && edit.budgetUsd !== null) {
    if (!Number.isFinite(edit.budgetUsd) || edit.budgetUsd <= 0) return "The budget must be a positive amount in dollars, or empty.";
    if (edit.budgetUsd > BUDGET_MAX_USD) return `The budget is more than ${BUDGET_MAX_USD.toLocaleString("en-US")} dollars. Check the figure.`;
  }
  if (edit.visualReferences !== undefined && edit.visualReferences !== null) {
    if (edit.visualReferences.length > REFERENCES_MAX) return `Name at most ${REFERENCES_MAX} visual references.`;
    if (edit.visualReferences.some((item) => item.trim().length > REFERENCE_MAX)) {
      return `A visual reference is longer than ${REFERENCE_MAX} characters.`;
    }
  }
  if (edit.successCriteria !== undefined && edit.successCriteria !== null && edit.successCriteria.trim().length > SUCCESS_MAX) {
    return `The success criteria are longer than ${SUCCESS_MAX} characters.`;
  }
  return null;
}

/**
 * Applies an edit. Each edited field becomes the person's value, with source "person". An empty edit of a field makes it "not set" again.
 * The fields the edit does not name keep their values and sources.
 */
export function applyFrameEdit(frame: BriefFrame, edit: FrameEdit): BriefFrame {
  const next: BriefFrame = { ...frame };
  if (edit.platform !== undefined) {
    const value = textOrNull(edit.platform ?? undefined);
    next.platform = value === null ? notSet() : { value, source: "person" };
  }
  if (edit.budgetUsd !== undefined) {
    next.budgetUsd = edit.budgetUsd === null ? notSet() : { value: Math.round(edit.budgetUsd * 100) / 100, source: "person" };
  }
  if (edit.visualReferences !== undefined) {
    const items = (edit.visualReferences ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
    next.visualReferences = items.length === 0 ? notSet() : { value: items, source: "person" };
  }
  if (edit.successCriteria !== undefined) {
    const value = textOrNull(edit.successCriteria ?? undefined);
    next.successCriteria = value === null ? notSet() : { value, source: "person" };
  }
  return next;
}

/**
 * Reads a stored frame. A stored value that does not fit the shape is not trusted: the field reads as not set. A brief written before the
 * frame existed has an empty frame, so every field reads as not set, and nothing is invented for it.
 */
export function parseFrame(stored: unknown): BriefFrame {
  const empty: BriefFrame = {
    voice: notSet(),
    prohibitedClaims: notSet(),
    requiredDisclaimers: notSet(),
    allowedClaims: notSet(),
    platform: notSet(),
    budgetUsd: notSet(),
    visualReferences: notSet(),
    successCriteria: notSet(),
  };
  let record: unknown = stored;
  if (typeof stored === "string") {
    try {
      record = JSON.parse(stored) as unknown;
    } catch {
      return empty;
    }
  }
  if (record === null || typeof record !== "object") return empty;
  const source = record as Record<string, unknown>;
  const read = <T>(key: keyof BriefFrame, accept: (value: unknown) => value is T): FrameField<T> => {
    const entry = source[key];
    if (entry === null || typeof entry !== "object") return notSet();
    const { value, source: origin } = entry as { value?: unknown; source?: unknown };
    if (value === null || value === undefined || !accept(value)) return notSet();
    const known = FRAME_SOURCES.includes(origin as FrameSource) && origin !== "not set" ? (origin as FrameSource) : "not set";
    return known === "not set" ? notSet() : { value, source: known };
  };
  const isString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
  return {
    voice: read("voice", isString),
    prohibitedClaims: read("prohibitedClaims", isString),
    requiredDisclaimers: read("requiredDisclaimers", isString),
    allowedClaims: read("allowedClaims", isString),
    platform: read("platform", isString),
    budgetUsd: read("budgetUsd", isNumber),
    visualReferences: read("visualReferences", isStrings),
    successCriteria: read("successCriteria", isString),
  };
}

/** A field as a person reads it: its value, or "Not set" with the reason it is not set. */
export function frameFieldText(field: FrameField<string | number | string[]>): string {
  if (field.value === null) return "Not set";
  if (Array.isArray(field.value)) return field.value.join("; ");
  return String(field.value);
}
