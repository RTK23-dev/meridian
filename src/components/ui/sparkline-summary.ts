/**
 * The text alternative for a sparkline: the point count, first and last value, and the range. It only restates stored
 * values. A value that is not a finite number is not a stored point, so it is left out of the count and the range.
 */
export function sparklineSummary(label: string, values: readonly number[]): string {
  const points = values.filter((value) => Number.isFinite(value));
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return `${label} trend: no points stored.`;
  const format = (value: number) => value.toLocaleString("en", { maximumFractionDigits: 2 });
  const noun = points.length === 1 ? "point" : "points";
  let lowest = first;
  let highest = first;
  for (const value of points) {
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  return `${label} trend over ${points.length} ${noun}: first ${format(first)}, last ${format(last)}, lowest ${format(lowest)}, highest ${format(highest)}.`;
}
