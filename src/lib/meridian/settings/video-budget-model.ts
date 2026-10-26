/**
 * The pure rules of the workspace's "Monthly video budget (USD)". The settings form and the server share them, so the form
 * refuses exactly what the server refuses. No database or Node module is imported here.
 */

/** The largest value the column (numeric(12, 2)) holds. */
export const MAX_MONTHLY_VIDEO_BUDGET_USD = 9_999_999_999.99;

export const VIDEO_BUDGET_MESSAGE =
  "Enter the monthly budget in US dollars: a number of 0 or more, with at most two decimals. Leave it blank for no budget.";

export type VideoBudgetParse = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * Parses a budget as a person typed it. Blank (or null) clears the budget. A number must be finite, 0 or more, with at most
 * two decimals, and within the column's range. Anything else is refused, never rounded or guessed.
 */
export function parseMonthlyVideoBudget(input: unknown): VideoBudgetParse {
  if (input === null || input === undefined) return { ok: true, value: null };
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false, message: VIDEO_BUDGET_MESSAGE };
    text = String(input);
  } else if (typeof input === "string") {
    text = input.trim();
  } else {
    return { ok: false, message: VIDEO_BUDGET_MESSAGE };
  }
  if (text === "") return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, message: VIDEO_BUDGET_MESSAGE };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > MAX_MONTHLY_VIDEO_BUDGET_USD) {
    return { ok: false, message: VIDEO_BUDGET_MESSAGE };
  }
  return { ok: true, value };
}
