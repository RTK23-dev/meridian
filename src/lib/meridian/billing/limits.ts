// The billing page's limits: every money or spend limit the engine, the factory and the decisions read, in one list (no precoded caps). Each
// limit has a unit, bounds, a scope (the workspace or one brand), and what it blocks while it is not set. A limit that is not set refuses
// the paid step it guards, with a message that names it; nothing starts on a default. The rules here are pure (no database, no Node module),
// so the page and the server refuse exactly the same values.

import { parseMonthlyVideoBudget } from "../settings/video-budget-model.ts";

/** The page the limits are set on, and the page every refusal points to. */
export const BILLING_PATH = "/billing";

export const LIMIT_KINDS = [
  "workspace_monthly_budget",
  "measure_ceiling",
  "decision_cap",
  "brand_budget",
  "factory_daily_cap",
  "factory_total_cap",
] as const;

export type LimitKind = (typeof LIMIT_KINDS)[number];

export type LimitScope = "workspace" | "brand";

export type LimitSpec = {
  label: string;
  scope: LimitScope;
  unit: string;
  /** The smallest and largest value a person may set. Zero is a value only where it is said to be (see zeroMeans). */
  min: number;
  max: number;
  /** The most decimal places a value may have. Cent caps have two; a per-call decision cap has three. */
  decimals: number;
  /** What a limit that is not set refuses, in plain words. */
  blocks: string;
  /** What zero means, when zero is allowed. Null when zero is not a value for this limit. */
  zeroMeans: string | null;
};

export const LIMIT_SPECS: Readonly<Record<LimitKind, LimitSpec>> = {
  workspace_monthly_budget: {
    label: "Monthly budget",
    scope: "workspace",
    unit: "USD",
    min: 0,
    max: 9_999_999_999.99,
    decimals: 2,
    blocks: "Paid text calls and engine video. A paid step starts only while the month's committed spend, and its own hold, fit under it.",
    zeroMeans: "No paid text or video is sent this month.",
  },
  measure_ceiling: {
    label: "Measure ceiling",
    scope: "workspace",
    unit: "USD per second",
    min: 0.01,
    max: 5,
    decimals: 2,
    blocks: "A measure run, for video and avatar steps that have no engine price. Each second of such a step is held to this ceiling.",
    zeroMeans: null,
  },
  decision_cap: {
    label: "Decision cap per call",
    scope: "workspace",
    unit: "USD per call",
    min: 0.001,
    max: 1,
    decimals: 3,
    blocks: "Each OpenRouter decision. A call whose most it can cost is above this cap is not sent.",
    zeroMeans: null,
  },
  brand_budget: {
    label: "Brand budget",
    scope: "brand",
    unit: "USD",
    min: 0,
    max: 100_000,
    decimals: 2,
    blocks: "Paid work for this brand: the factory, the studio and production. A reservation starts only while the brand's spend and holds fit under it.",
    zeroMeans: "No paid work is started for this brand.",
  },
  factory_daily_cap: {
    label: "Factory daily spend cap",
    scope: "brand",
    unit: "USD a day",
    min: 0.01,
    max: 100_000,
    decimals: 2,
    blocks: "The factory's spend for this brand in one day. The factory does not spend until both its daily and its total cap are set.",
    zeroMeans: null,
  },
  factory_total_cap: {
    label: "Factory total spend cap",
    scope: "brand",
    unit: "USD",
    min: 0.01,
    max: 100_000,
    decimals: 2,
    blocks: "The factory's spend for this brand, all runs together. The factory does not spend until both its daily and its total cap are set.",
    zeroMeans: null,
  },
};

export function isLimitKind(value: unknown): value is LimitKind {
  return typeof value === "string" && (LIMIT_KINDS as readonly string[]).includes(value);
}

/** The outcome of reading a value a person typed. A blank value is null (unset), except where zero is the only way to stop (brand budget). */
export type LimitParse = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * Parses one limit's value. Blank clears a limit (unset), except the brand budget, which must be a number: zero stops the brand's paid work,
 * and an unset budget would be a default. A value is finite, within its bounds, and has no more decimal places than its unit allows. Anything
 * else is refused, never rounded or guessed.
 */
export function parseLimitValue(kind: LimitKind, raw: unknown): LimitParse {
  if (kind === "workspace_monthly_budget") {
    const parsed = parseMonthlyVideoBudget(raw);
    return parsed.ok ? parsed : { ok: false, message: parsed.message };
  }
  const spec = LIMIT_SPECS[kind];
  const blank = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (blank) {
    if (kind === "brand_budget") return { ok: false, message: `Enter the ${spec.label.toLowerCase()} in US dollars. Enter 0 to stop all paid work for this brand.` };
    return { ok: true, value: null };
  }
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const decimalPattern = new RegExp(`^\\d+(\\.\\d{1,${spec.decimals}})?$`);
  if (!decimalPattern.test(text)) {
    return { ok: false, message: `${spec.label} must be a number in ${spec.unit}, with at most ${spec.decimals} decimal place${spec.decimals === 1 ? "" : "s"}.` };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return { ok: false, message: `${spec.label} must be between ${spec.min} and ${spec.max} ${spec.unit}.` };
  }
  if (value === 0 && spec.zeroMeans === null) {
    return { ok: false, message: `${spec.label} must be above zero. To clear it, leave the field blank.` };
  }
  return { ok: true, value };
}

/** A factory cap in whole cents, from its dollar value. Null when the value is null (unset). Pure. */
export function centsOf(usd: number | null): number | null {
  return usd === null ? null : Math.round(usd * 100);
}

/** The pair of factory caps must satisfy the rule the factory enforces: the daily cap is not above the total cap. Returns the problem, or null. */
export function factoryCapsProblem(daily: number | null, total: number | null): string | null {
  if (daily !== null && total !== null && daily > total) return "The factory daily spend cap cannot be above its total cap.";
  return null;
}

/** The limits a page shows for a scope, in the order the page lists them. */
export function limitsFor(scope: LimitScope): LimitKind[] {
  return LIMIT_KINDS.filter((kind) => LIMIT_SPECS[kind].scope === scope);
}

/** The short status of one limit, for the page. Unset is a state of its own, never a value. */
export function limitStatusText(kind: LimitKind, value: number | null): string {
  const spec = LIMIT_SPECS[kind];
  if (value === null) return "Not set. The step it guards is refused until you set it.";
  if (value === 0 && spec.zeroMeans !== null) return spec.zeroMeans;
  return `${formatAmount(value, spec.decimals)} ${spec.unit}`;
}

export function formatAmount(value: number, decimals: number): string {
  return value.toFixed(decimals);
}
