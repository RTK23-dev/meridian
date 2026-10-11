/**
 * CSV for exports. Pure: rows in, CSV text out.
 *
 * Text cells are always quoted and embedded quotes are doubled. Cells that start with = + - @ (or a tab or carriage
 * return) get a leading apostrophe, so a spreadsheet shows them as text and does not run them as formulas. Numbers are
 * written as numbers. Null, undefined and non-finite numbers are empty cells: an unknown value is never written as 0.
 */
import { redactSecrets } from "../observability/redact.ts";

export type CsvColumn<T> = { label: string; value: (row: T) => unknown };

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : "") : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Header row, then one line per row, joined with CRLF. */
export function csvTable<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const body = rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(","));
  return [header, ...body].join("\r\n");
}

/** Labels match the opportunities screen export. */
export type OpportunityExportRow = {
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

const OPPORTUNITY_COLUMNS: CsvColumn<OpportunityExportRow>[] = [
  { label: "Opportunity", value: (row) => row.label },
  { label: "Evidence category", value: (row) => row.category },
  { label: "Status", value: (row) => row.status },
  { label: "Rank score", value: (row) => row.expectedValue },
  { label: "JEV decision", value: (row) => row.decision },
  { label: "Probability", value: (row) => row.probability },
  { label: "Evidence confidence", value: (row) => row.confidence },
  { label: "Risk", value: (row) => row.risk },
  { label: "Reason", value: (row) => row.reason },
];

export function opportunitiesCsv(rows: readonly OpportunityExportRow[]): string {
  return csvTable(OPPORTUNITY_COLUMNS, rows);
}

/** Labels match the library screen export. */
export type LibraryExportRow = {
  id: string;
  title: string;
  hook: string;
  angle: string;
  status: string;
  origin: string;
  createdAt: string;
};

const LIBRARY_COLUMNS: CsvColumn<LibraryExportRow>[] = [
  { label: "Creative ID", value: (row) => row.id },
  { label: "Title", value: (row) => row.title },
  { label: "Hook", value: (row) => row.hook },
  { label: "Angle", value: (row) => row.angle },
  { label: "Status", value: (row) => row.status },
  { label: "Origin", value: (row) => row.origin },
  { label: "Created at", value: (row) => row.createdAt },
];

export function libraryCsv(rows: readonly LibraryExportRow[]): string {
  return csvTable(LIBRARY_COLUMNS, rows);
}

/** Labels match the learning screen performance export. */
export type PerformanceExportRow = {
  id: string;
  creativeId: string;
  experimentId: string;
  platform: string;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  conversions: number | null;
  spendCents: number | null;
  revenueCents: number | null;
  observedOn: string;
  source: string;
  createdAt: string;
};

const PERFORMANCE_COLUMNS: CsvColumn<PerformanceExportRow>[] = [
  { label: "Observation ID", value: (row) => row.id },
  { label: "Creative ID", value: (row) => row.creativeId },
  { label: "Experiment ID", value: (row) => row.experimentId },
  { label: "Platform", value: (row) => row.platform },
  { label: "Impressions", value: (row) => row.impressions },
  { label: "Reach", value: (row) => row.reach },
  { label: "Clicks", value: (row) => row.clicks },
  { label: "Conversions", value: (row) => row.conversions },
  { label: "Spend cents", value: (row) => row.spendCents },
  { label: "Revenue cents", value: (row) => row.revenueCents },
  { label: "Observed on", value: (row) => row.observedOn },
  { label: "Source", value: (row) => row.source },
  { label: "Recorded at", value: (row) => row.createdAt },
];

export function performanceCsv(rows: readonly PerformanceExportRow[]): string {
  return csvTable(PERFORMANCE_COLUMNS, rows);
}

export type AuditExportRow = {
  createdAt: string;
  actorName: string;
  actorId: string;
  action: string;
  brandName: string;
  objectType: string;
  objectId: string;
  metadata: Record<string, string>;
};

const AUDIT_COLUMNS: CsvColumn<AuditExportRow>[] = [
  { label: "Recorded at", value: (row) => row.createdAt },
  { label: "Actor", value: (row) => row.actorName },
  { label: "Actor ID", value: (row) => row.actorId },
  { label: "Action", value: (row) => row.action },
  { label: "Brand", value: (row) => row.brandName },
  { label: "Object type", value: (row) => row.objectType },
  { label: "Object ID", value: (row) => row.objectId },
  // Metadata is written by the server, but it is still passed through the same secret redaction as job text.
  { label: "Metadata", value: (row) => redactSecrets(JSON.stringify(row.metadata)) },
];

export function auditCsv(rows: readonly AuditExportRow[]): string {
  return csvTable(AUDIT_COLUMNS, rows);
}
