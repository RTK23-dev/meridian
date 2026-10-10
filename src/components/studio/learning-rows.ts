/**
 * Rows for the learning chart and its text alternative. Pure. Patterns are ordered by lift, highest first. A pattern whose lift
 * is not a finite number is left out of the chart and kept in the text list, so no bar is drawn from a made-up value.
 */

export type LearningPatternInput = {
  summary: string;
  lift: number;
  attribute: string;
  value: string;
  sampleSize: number;
  impressions: number;
  state: string;
  direction: string;
};

export type LearningRow = {
  key: string;
  label: string;
  lift: number;
  sampleSize: number;
  impressions: number;
  direction: string;
  state: string;
  summary: string;
};

const LABEL_LIMIT = 32;

function shortLabel(attribute: string, value: string): string {
  const text = `${attribute}: ${value}`.replaceAll("_", " ").trim();
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text;
}

export function learningRows(patterns: readonly LearningPatternInput[]): { charted: LearningRow[]; unplotted: LearningRow[] } {
  const rows = patterns.map((pattern, index): LearningRow => ({
    key: `${pattern.attribute}:${pattern.value}:${index}`,
    label: shortLabel(pattern.attribute, pattern.value),
    lift: pattern.lift,
    sampleSize: pattern.sampleSize,
    impressions: pattern.impressions,
    direction: pattern.direction,
    state: pattern.state,
    summary: pattern.summary,
  }));
  const charted = rows
    .filter((row) => Number.isFinite(row.lift))
    .sort((left, right) => right.lift - left.lift);
  const unplotted = rows.filter((row) => !Number.isFinite(row.lift));
  return { charted, unplotted };
}
