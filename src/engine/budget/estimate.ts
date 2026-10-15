// Estimate a scene plan before anything is spent (Bible 14.1 step 1, 6.5, 14.2). Pure: config in, numbers out.
// A shot whose price is unknown makes the estimate fail with a typed error that names the shot. It never returns 0.

import { budgets } from "../config/budgets.ts";
import { prices, priceFor, type PriceKey, type PriceUnit } from "../config/prices.ts";
import {
  EngineError,
  roundUsd,
  scenePlanSchema,
  sumUsd,
  type BudgetLine,
  type ModelClass,
  type ScenePlan,
  type ShotSpec,
} from "../contracts/index.ts";

/** A shot has no known price, so the estimate refuses. Carries the shot id. */
export class UnknownPriceError extends EngineError {
  shotId: string;

  constructor(shotId: string, message: string) {
    super("unknown_price", message, { stage: "estimate_reserve" });
    this.shotId = shotId;
  }
}

export type Estimate = {
  /**
   * One line per paid call, in shot order, then the fixed per-master lines. A generate, stock, component or asset shot has one
   * line; a chain (contract v5) has one line for each of its calls.
   */
  lines: BudgetLine[];
  /** Sum of the shot lines. For a valid plan this equals ScenePlan.estimatedUsd. */
  shotsUsd: number;
  /** Sum of the generated-shot lines only. The redo allowance is a share of this. */
  generatedUsd: number;
  /** Sum of the fixed per-master lines (about $0.52). */
  fixedUsd: number;
  /** shotsUsd + fixedUsd: the estimate without the redo allowance. */
  estimateUsd: number;
  redoAllowanceUsd: number;
  /** estimateUsd + redoAllowanceUsd: what a new reservation holds. */
  reservedUsd: number;
  configVersions: { prices: string; budgets: string };
};

type KnownPrice = { unit: PriceUnit; usd: number };

/** The price for a key, or a typed error naming the shot when the price is unknown. */
function knownPrice(key: PriceKey, shot: ShotSpec): KnownPrice {
  const price = priceFor(key);
  if (price.usd === null) {
    throw new UnknownPriceError(
      shot.shotId,
      `shot ${shot.shotId} (${shot.visualType}) has no known price for ${key}; the estimate refuses to guess`,
    );
  }
  return { unit: price.unit, usd: price.usd };
}

/** Billable units for one shot at a price unit, or null when that unit cannot price a single shot. */
function billableUnits(unit: PriceUnit, shot: ShotSpec, takes: number): number | null {
  switch (unit) {
    case "per_second":
      return ((shot.endMs - shot.startMs) / 1000) * takes;
    case "per_image":
    case "per_call":
      return takes;
    default:
      return null;
  }
}

function shotCost(key: PriceKey, shot: ShotSpec, takes: number): number {
  const price = knownPrice(key, shot);
  const units = billableUnits(price.unit, shot, takes);
  if (units === null) {
    throw new UnknownPriceError(
      shot.shotId,
      `shot ${shot.shotId} is priced ${price.unit} (${key}), which cannot price one shot; the estimate refuses to guess`,
    );
  }
  return roundUsd(price.usd * units);
}

/** One line for one paid call of a shot: the route's price key for its model class, priced over the call's takes. */
function callLine(shot: ShotSpec, modelClass: ModelClass, takes: number): BudgetLine {
  const key = prices.routeFor[modelClass];
  return { stage: "produce_shot", shotId: shot.shotId, provider: key, estimateUsd: shotCost(key, shot, takes) };
}

/**
 * The lines of one shot, and whether it is generated (the redo allowance is a share of generated lines). A generate shot has one
 * call. A chain (contract v5) has one line per call, so every link is reserved: a per-second call bills the shot's length, and a
 * per-image call bills its takes. Components, stock and assets have one line at their source's price.
 */
function linesForShot(shot: ShotSpec): { lines: BudgetLine[]; generated: boolean } {
  const { source } = shot;
  switch (source.kind) {
    case "generate":
      return { lines: [callLine(shot, source.modelClass, source.takes)], generated: true };
    case "chain":
      return { lines: source.calls.map((call) => callLine(shot, call.modelClass, call.takes)), generated: true };
    case "component":
    case "stock":
    case "asset": {
      const key = prices.sourceRoutes[source.kind];
      return {
        lines: [{ stage: "produce_shot", shotId: shot.shotId, provider: key, estimateUsd: shotCost(key, shot, 1) }],
        generated: false,
      };
    }
  }
}

/**
 * The fixed per-master lines (14.2): Claude roles, critic, render, and speech-to-text with ffmpeg. Exported for the
 * pre-flight hold (preflight.ts): intake reserves these lines alone, and estimate_reserve later replaces them with the plan's.
 */
export function fixedBudgetLines(): BudgetLine[] {
  return [
    { stage: budgets.fixedStages.claudeRoles, estimateUsd: budgets.fixedPerMasterUsd.claudeRoles },
    { stage: budgets.fixedStages.critic, estimateUsd: budgets.fixedPerMasterUsd.critic },
    { stage: budgets.fixedStages.render, estimateUsd: budgets.fixedPerMasterUsd.render },
    { stage: budgets.fixedStages.media, estimateUsd: budgets.fixedPerMasterUsd.speechAndFfmpeg },
  ];
}

/**
 * Estimate a plan. Throws a typed EngineError for an invalid plan, and UnknownPriceError for a shot whose price is
 * unknown. The redo allowance (Bible 6.5, 14.1) is a share of the generated-shot cost only.
 */
export function estimatePlan(plan: ScenePlan): Estimate {
  const parsed = scenePlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `scene plan is invalid: ${parsed.error.message}`, {
      stage: "estimate_reserve",
    });
  }

  const shotResults = parsed.data.shots.map(linesForShot);
  const shotLines = shotResults.flatMap((result) => result.lines);
  const generatedLines = shotResults.filter((result) => result.generated).flatMap((result) => result.lines);
  const fixed = fixedBudgetLines();

  const shotsUsd = sumUsd(shotLines.map((line) => line.estimateUsd));
  const generatedUsd = sumUsd(generatedLines.map((line) => line.estimateUsd));
  const fixedUsd = sumUsd(fixed.map((line) => line.estimateUsd));
  const estimateUsd = sumUsd([shotsUsd, fixedUsd]);
  const redoAllowanceUsd = roundUsd(generatedUsd * budgets.redoAllowanceShare.value);

  return {
    lines: [...shotLines, ...fixed],
    shotsUsd,
    generatedUsd,
    fixedUsd,
    estimateUsd,
    redoAllowanceUsd,
    reservedUsd: sumUsd([estimateUsd, redoAllowanceUsd]),
    configVersions: { prices: prices.version, budgets: budgets.version },
  };
}
