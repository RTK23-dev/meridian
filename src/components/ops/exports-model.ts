/**
 * Row mapping for the exports screen. The CSV builders in lib/meridian/exports/csv.ts do the cell rules (formula-safe text,
 * empty cells for unknown numbers). This file only picks the columns from each list the server returns.
 */
import type { LibraryExportRow, OpportunityExportRow } from "@/lib/meridian/exports/csv";
import { isoTimestamp } from "@/lib/meridian/observability/timestamps";

export type OpportunityLike = {
  label: string;
  category: string;
  status: string;
  expectedValue: number | null;
  decision: string;
  probability: number | null;
  confidence: number | null;
  risk: number | null;
  reason: string;
};

/** Probability is written only when a JEV decision exists, the same rule the opportunities screen uses. */
export function opportunityExportRows(items: readonly OpportunityLike[]): OpportunityExportRow[] {
  return items.map((item) => ({
    label: item.label,
    category: item.category,
    status: item.status,
    expectedValue: item.expectedValue,
    decision: item.decision || "None stored",
    probability: item.decision ? item.probability : null,
    confidence: item.confidence,
    risk: item.risk,
    reason: item.reason,
  }));
}

export type LibraryLike = {
  id: string;
  title: string;
  hook: string;
  angle: string;
  status: string;
  origin: string;
  createdAt: string;
};

export function libraryExportRows(items: readonly LibraryLike[]): LibraryExportRow[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    hook: item.hook,
    angle: item.angle,
    status: item.status,
    origin: item.origin,
    createdAt: isoTimestamp(item.createdAt),
  }));
}

/**
 * What a finished export holds. A file with no rows still has its header row. The plural is given where it is not the
 * singular with an "s" ("opportunity" is "opportunities").
 */
export function rowsNote(count: number, noun: string, plural: string = `${noun}s`): string {
  if (count === 0) return `No ${plural} were found for this brand, so the file has only its header row.`;
  return `The file has ${count.toLocaleString()} ${count === 1 ? noun : plural}.`;
}
