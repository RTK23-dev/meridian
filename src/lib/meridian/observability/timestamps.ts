/**
 * ISO text for a timestamp read from the database. Drivers return Date objects for timestamptz, and String(date) is
 * not ISO (it gives "Sat Oct 10 2026 ..."), so day grouping and sorting must not use String() on them.
 */
export function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  if (typeof value !== "string" || !value.trim()) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

/** The UTC calendar day (YYYY-MM-DD) of a timestamp, or "" when it has no valid time. */
export function utcDay(value: unknown): string {
  const iso = isoTimestamp(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : "";
}
