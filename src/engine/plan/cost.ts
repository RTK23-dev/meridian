// Shot cost for the visual decision engine (Bible 6.5, 7.1 and 14.1). It prices one candidate type for one shot with the
// same price table and the same billing rule as the budget estimate (engine/budget/estimate.ts), so the plan the planner
// fits reserves the same money the budget reserves. An unknown (null) price is never 0: the candidate is unknown.

import { budgets } from "../config/budgets.ts";
import { priceFor, prices, type PriceKey, type PriceUnit } from "../config/prices.ts";
import { roundUsd, sumUsd, type VisualType } from "../contracts/index.ts";
import { RECIPES, type Recipe } from "./tables.ts";

/** The redo allowance share (6.5, 14.1), tuned in config. */
export const REDO_ALLOWANCE_SHARE: number = budgets.redoAllowanceShare.value;

/** The fixed per-master lines (14.2): Claude roles, critic, render and speech with ffmpeg. */
export const FIXED_PER_MASTER_USD: number = sumUsd(Object.values(budgets.fixedPerMasterUsd));

/** USD is carried as integer ten-thousandths (4 decimals, money.ts). */
export const MICRO_PER_USD = 10000;

/** USD as integer ten-thousandths, so that comparisons do not drift on float noise. */
export function usdUnits(value: number): number {
  return Math.round(value * MICRO_PER_USD);
}

/** True when value is at or below limit, to 4 decimals. */
export function usdAtMost(value: number, limit: number): boolean {
  return usdUnits(value) <= usdUnits(limit);
}

export type KnownShotCost = {
  known: true;
  visualType: VisualType;
  routeKey: PriceKey;
  generated: boolean;
  takes: number;
  /** Shot cost before the redo allowance. */
  baseUsd: number;
  /** Redo allowance for a generated shot (6.5), zero otherwise. */
  allowanceUsd: number;
  /** baseUsd plus allowanceUsd: what the candidate costs against the remaining budget (7.2 rule 5). */
  totalUsd: number;
};

export type UnknownShotCost = {
  known: false;
  visualType: VisualType;
  routeKey: PriceKey;
  reason: string;
};

export type ShotCost = KnownShotCost | UnknownShotCost;

function routeKeyOf(recipe: Recipe): PriceKey {
  switch (recipe.kind) {
    case "generate":
      return prices.routeFor[recipe.modelClass];
    case "stock":
      return prices.sourceRoutes.stock;
    case "component":
      return prices.sourceRoutes.component;
  }
}

/** Billable units for one shot, mirroring estimate.ts. Null when the unit cannot price this shot. */
function billableUnits(recipe: Recipe, unit: PriceUnit, durationMs: number): number | null {
  const seconds = durationMs / 1000;
  const takes = recipe.kind === "generate" ? recipe.takes : 1;
  if (recipe.kind === "generate" && recipe.billing === "frame") {
    return unit === "per_image" ? Math.ceil(seconds * recipe.framesPerSecond) * takes : null;
  }
  if (unit === "per_second") {
    return seconds * takes;
  }
  if (unit === "per_image" || unit === "per_call") {
    return takes;
  }
  return null;
}

/** The cost of one candidate type on a shot of durationMs. A null price, or a unit that cannot price the shot, is unknown. */
export function shotCost(visualType: VisualType, durationMs: number): ShotCost {
  const recipe = RECIPES[visualType];
  const routeKey = routeKeyOf(recipe);
  const price = priceFor(routeKey);
  if (price.usd === null) {
    return { known: false, visualType, routeKey, reason: `${routeKey} has no known price` };
  }
  const units = billableUnits(recipe, price.unit, durationMs);
  if (units === null) {
    return {
      known: false,
      visualType,
      routeKey,
      reason: `${routeKey} is priced ${price.unit}, which cannot price this shot`,
    };
  }
  const generated = recipe.kind === "generate";
  const baseUsd = roundUsd(price.usd * units);
  const allowanceUsd = generated ? roundUsd(baseUsd * REDO_ALLOWANCE_SHARE) : 0;
  return {
    known: true,
    visualType,
    routeKey,
    generated,
    takes: recipe.kind === "generate" ? recipe.takes : 1,
    baseUsd,
    allowanceUsd,
    totalUsd: sumUsd([baseUsd, allowanceUsd]),
  };
}

export type PlanLine = { baseUsd: number; generated: boolean };

export type PlanTotals = {
  shotsUsd: number;
  generatedUsd: number;
  allowanceUsd: number;
  fixedUsd: number;
  /** Shots, fixed lines and the allowance: the same figure estimatePlan(plan).reservedUsd gives. */
  reservedUsd: number;
};

/** Plan totals with the same rounding as estimatePlan (engine/budget/estimate.ts). */
export function planTotals(lines: readonly PlanLine[]): PlanTotals {
  const shotsUsd = sumUsd(lines.map((line) => line.baseUsd));
  const generatedUsd = sumUsd(lines.filter((line) => line.generated).map((line) => line.baseUsd));
  const allowanceUsd = roundUsd(generatedUsd * REDO_ALLOWANCE_SHARE);
  const fixedUsd = FIXED_PER_MASTER_USD;
  return {
    shotsUsd,
    generatedUsd,
    allowanceUsd,
    fixedUsd,
    reservedUsd: sumUsd([fixedUsd, shotsUsd, allowanceUsd]),
  };
}

/** The budget left for shots: the request budget less the fixed lines, never below 0 (a negative room is no room). */
export function shotRoomUsd(requestBudgetUsd: number): number {
  const room = usdUnits(requestBudgetUsd) - usdUnits(FIXED_PER_MASTER_USD);
  return room > 0 ? room / MICRO_PER_USD : 0;
}
