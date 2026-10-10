/**
 * What changed between two briefs. Pure. A field counts as changed when its text differs after trimming. Lists are compared
 * item by item, joined in order, so a reordered list is a change.
 */

export type BriefFields = {
  title: string;
  audience: string;
  angle: string;
  hook: string;
  promise: string;
  offer: string;
  cta: string;
  format: string;
  proofType: string;
  constraints: string;
  why: string[];
  learningNotes: string[];
};

export const BRIEF_FIELD_LABELS: Record<keyof BriefFields, string> = {
  title: "Title",
  audience: "Audience",
  angle: "Angle",
  hook: "Hook",
  promise: "Promise",
  offer: "Offer",
  cta: "Call to action",
  format: "Format",
  proofType: "Proof",
  constraints: "What not to do",
  why: "Why this, why now",
  learningNotes: "Learned notes",
};

export type BriefChange = { field: keyof BriefFields; label: string; before: string; after: string };

function textOf(value: string | string[]): string {
  return Array.isArray(value) ? value.map((item) => item.trim()).join(" · ") : value.trim();
}

export function briefChanges(current: BriefFields, previous: BriefFields): BriefChange[] {
  const fields = Object.keys(BRIEF_FIELD_LABELS) as (keyof BriefFields)[];
  return fields.flatMap((field) => {
    const before = textOf(previous[field]);
    const after = textOf(current[field]);
    return before === after ? [] : [{ field, label: BRIEF_FIELD_LABELS[field], before, after }];
  });
}
