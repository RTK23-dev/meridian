/**
 * A stored probability or confidence, read back. A value that was never stored, or is not a finite number, is null: unknown.
 * It is never 0, because 0 is a measured value. The screens show null as "Unknown".
 */
export function storedProbability(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
