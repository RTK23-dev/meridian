/** Formatting shared by the operations screens. Missing values read "Unknown"; nothing is estimated. */

/** A stored timestamp in this browser's time zone, or "Unknown" when the value is missing or unreadable. */
export function timestampLabel(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "Unknown";
  return new Date(iso).toLocaleString();
}

/** A file name with the date it was made, such as meridian-audit-2026-10-10.csv. */
export function exportFilename(prefix: string, now: Date): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}.csv`;
}

/** The visible range and page count for one page of results. A total of zero shows no rows and one page. */
export function pageSpan(page: number, pageSize: number, total: number): { first: number; last: number; pageCount: number } {
  const size = pageSize > 0 ? pageSize : 1;
  const first = total === 0 ? 0 : page * size + 1;
  const last = Math.min(total, (page + 1) * size);
  return { first, last, pageCount: Math.max(1, Math.ceil(total / size)) };
}
