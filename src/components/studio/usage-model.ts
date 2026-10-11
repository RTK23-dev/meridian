/**
 * Pure rules for the generation limit meters. A count is shown only when the server reported it. A missing count is
 * "unknown", and no bar is drawn for it, so a number is never made up. No React here.
 */

export type MeterSummary =
  | { known: false; line: string }
  | { known: true; percent: number; summary: string; atLimit: boolean };

/** `used` is null when the count did not load. `limit` is the server's limit, which the server always states. */
export function meterSummary(used: number | null, limit: number, unit: string): MeterSummary {
  if (used === null || !Number.isFinite(used) || used < 0) {
    return { known: false, line: `Usage unknown. The limit is ${limit} ${unit}. The count did not load, so no bar is drawn.` };
  }
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return { known: true, percent, summary: `${used} of ${limit} ${unit}`, atLimit: used >= limit };
}
