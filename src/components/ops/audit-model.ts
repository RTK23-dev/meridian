/**
 * Pure rules for the audit log screen. The page size and the export cap are copies of the server's constants
 * (AUDIT_PAGE_SIZE and AUDIT_EXPORT_LIMIT in observability/actions.ts). The export response also reports its cap, and
 * the note uses that value once a file exists.
 */
import { redactSecrets } from "../../lib/meridian/observability/redact.ts";

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_CAP = 5_000;

export type AuditFilters = { actor: string; action: string; brandId: string; from: string; to: string };
export const EMPTY_AUDIT_FILTERS: AuditFilters = { actor: "", action: "", brandId: "", from: "", to: "" };

/** A start date after the end date matches nothing, so the form asks for a fix before it runs the search. */
export function dateRangeProblem(from: string, to: string): string | null {
  if (from && to && from > to) return "The start date is after the end date. Change one of the dates.";
  return null;
}

/**
 * Metadata as one line of key and value pairs, with the line clipped. Secrets go through redactSecrets, which removes the
 * forms it knows: access and refresh tokens and client secrets written as key=value, bearer headers and their JSON fields.
 * It does not remove an arbitrary value under a key such as "token", so the server must not write one into metadata.
 */
export function auditDetailsText(metadata: Record<string, string>): string {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "";
  return redactSecrets(entries.map(([key, value]) => `${key}: ${value}`).join(" · ")).slice(0, 240);
}

/** The sentence under the export button once a file has been generated. It states what the file holds. */
export function auditExportNote(result: { rowCount: number; total: number; truncated: boolean; limit: number }): string {
  if (result.total === 0) return "No entries matched these filters, so the file has only its header row.";
  if (result.truncated) {
    return `The file has the newest ${result.rowCount.toLocaleString()} of ${result.total.toLocaleString()} matching entries. Exports stop at ${result.limit.toLocaleString()} rows, so narrow the dates to get the rest.`;
  }
  return `The file has all ${result.rowCount.toLocaleString()} matching ${result.rowCount === 1 ? "entry" : "entries"}.`;
}

/** The action code as stored, for example calibration.approved. Filters match against this text. */
export function actionLabel(action: string): string {
  return action || "Unknown action";
}
