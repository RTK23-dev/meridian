// Measure mode for unpriced video (owner direction 2026-10-23, decision D15). An admin may start a run in measure mode. In it, a video or
// avatar step whose model has no engine price may run. Its hold is a per-second ceiling times its length in seconds, the workspace's
// policy value (measureCeilingUsdPerSecond). When the provider reports an actual cost, that cost replaces the hold. A step with no hold
// does not run: nothing here assumes a free call. Pure: no database, no provider.

import { roundUpUsd } from "../budget/line.ts";
import type { PlanNode } from "./contracts.ts";

/** The measure mode of a run: the most a video or avatar step without a price is held to, per second of its length. */
export type MeasureOptions = { ceilingUsdPerSecond: number };

/** The hold of a measured step: its ceiling times its length. Null when measure mode is off, the step is not a video or avatar, its length
 * is not a positive number, or the ceiling is not positive, so the step does not run. */
export function measuredHoldUsd(node: PlanNode, measure: MeasureOptions | null): number | null {
  if (measure === null || !(measure.ceilingUsdPerSecond > 0)) return null;
  if (node.kind !== "video" && node.kind !== "avatar") return null;
  const seconds = node.params.seconds;
  if (typeof seconds !== "number" || !(seconds > 0)) return null;
  return roundUpUsd(seconds * measure.ceilingUsdPerSecond);
}

/** The hold a paid step takes: its engine estimate, or in measure mode its ceiling. Null when neither applies: the step does not run. */
export function holdUsdOf(node: PlanNode, measure: MeasureOptions | null): number | null {
  return node.estimateUsd ?? measuredHoldUsd(node, measure);
}
