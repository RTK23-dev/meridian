/**
 * Metadata diff for two variants in the compare view. Pure. Each row says which values match, in words, so the result does not
 * depend on colour. A question id present on one side only shows "No row" on the other.
 */

export type CompareQuestion = { id: string; decision: string; answer: string };

export type CompareVariant = {
  kind: string;
  provider: string;
  model: string;
  promptVersion: string;
  creativeStatus: string;
  reviewStatus: string;
  qaDecision: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  questions: readonly CompareQuestion[];
};

export type DiffRow = { field: string; a: string; b: string; same: boolean };

function shown(value: string | number | null | undefined, empty: string): string {
  if (value === null || value === undefined) return empty;
  const text = String(value).trim();
  return text ? text : empty;
}

function durationText(durationMs: number | null): string {
  return durationMs ? `${(durationMs / 1000).toFixed(1)} s` : "Not stored";
}

function dimensionsText(width: number | null, height: number | null): string {
  return width && height ? `${width} × ${height}` : "Not stored";
}

export function variantMetadataDiff(a: CompareVariant, b: CompareVariant): DiffRow[] {
  const rows: DiffRow[] = [];
  const add = (field: string, left: string, right: string) => {
    rows.push({ field, a: left, b: right, same: left === right });
  };
  add("Kind", shown(a.kind, "Not stored"), shown(b.kind, "Not stored"));
  add("Provider", shown(a.provider, "Not stored"), shown(b.provider, "Not stored"));
  add("Model", shown(a.model, "Not stored"), shown(b.model, "Not stored"));
  add("Prompt version", shown(a.promptVersion, "Not stored"), shown(b.promptVersion, "Not stored"));
  add("Creative status", shown(a.creativeStatus, "Not stored"), shown(b.creativeStatus, "Not stored"));
  add("Review status", shown(a.reviewStatus, "Not stored"), shown(b.reviewStatus, "Not stored"));
  add("QA decision", shown(a.qaDecision, "Pending"), shown(b.qaDecision, "Pending"));
  add("Duration", durationText(a.durationMs), durationText(b.durationMs));
  add("Dimensions", dimensionsText(a.width, a.height), dimensionsText(b.width, b.height));

  const ids = [...new Set([...a.questions.map((question) => question.id), ...b.questions.map((question) => question.id)])].sort();
  for (const id of ids) {
    const left = a.questions.find((question) => question.id === id);
    const right = b.questions.find((question) => question.id === id);
    add(`QA ${id} decision`, left ? shown(left.decision, "Not stored") : "No row", right ? shown(right.decision, "Not stored") : "No row");
    add(`QA ${id} answer`, left ? shown(left.answer, "Unrecorded") : "No row", right ? shown(right.answer, "Unrecorded") : "No row");
  }
  return rows;
}
