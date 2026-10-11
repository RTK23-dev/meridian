/**
 * The sources page limit: how many pages a crawl may read. It is a whole number of pages, 1 or more. The settings form and
 * the server save both use this one rule, so they cannot disagree. This module imports nothing, so the browser bundle can
 * use it directly.
 */

export const PAGE_LIMIT_MESSAGE = "Enter the number of pages as a whole number, 1 or more.";

/** The page limit as a whole number, or null when the value is not one. Blank, fractional, negative and zero values are null. */
export function parsePageLimit(value: unknown): number | null {
  let number = Number.NaN;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && value.trim() !== "") number = Number(value.trim());
  return Number.isInteger(number) && number >= 1 ? number : null;
}
