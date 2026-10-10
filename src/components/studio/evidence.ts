/**
 * Plain-language reading of the stored JEV rows for a variant. Pure. A probability or confidence that is missing or not a
 * finite number is shown as "unknown", never as zero.
 */

export type EvidenceRow = {
  id: string;
  decision: string;
  answer: string;
  probability: number | null | undefined;
  confidence: number | null | undefined;
};

export function formatUnitInterval(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "unknown";
}

/** The decision as a sentence a reviewer can read. The stored code is kept in the table beside it. */
export function decisionPlainLabel(decision: string): string {
  if (decision === "AUTO_APPROVE") return "Auto-approved";
  if (decision === "HUMAN_REVIEW") return "Needs a person";
  if (decision === "REJECT") return "Rejected";
  return decision ? decision.replaceAll("_", " ").toLowerCase() : "No decision stored";
}

/**
 * One paragraph above the table. It says what the rows add up to, in words, and counts from the rows only. With no rows it
 * says so, and it does not supply a verdict.
 */
export function summarizeEvidence(rows: readonly EvidenceRow[]): string {
  if (rows.length === 0) return "No JEV row is stored for this variant, so there is no evidence to show.";
  const auto = rows.filter((row) => row.decision === "AUTO_APPROVE").length;
  const human = rows.filter((row) => row.decision === "HUMAN_REVIEW").length;
  const rejected = rows.filter((row) => row.decision === "REJECT").length;
  const other = rows.length - auto - human - rejected;
  const unknown = rows.filter((row) => formatUnitInterval(row.probability) === "unknown").length;

  let verdict: string;
  if (rejected > 0) verdict = "At least one question rejected this variant.";
  else if (human > 0) verdict = "No question rejected it, but at least one needs a person to decide.";
  else if (auto === rows.length) verdict = "Every question auto-approved it.";
  else verdict = "The decisions are mixed. Read the table below.";

  const counts = `${rows.length} question${rows.length === 1 ? "" : "s"}: ${auto} auto-approved, ${human} need a person, ${rejected} rejected${other > 0 ? `, ${other} other` : ""}.`;
  const unknownNote = unknown > 0 ? ` ${unknown} with an unknown probability.` : "";
  return `${verdict} ${counts}${unknownNote}`;
}
