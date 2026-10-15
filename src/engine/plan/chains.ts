// Chains (Bible 7.1, contract v5): the paid calls a generated type makes, in order. Pure. One module holds the call shapes, so the
// planner prices a chain from the same calls the builder writes (sources.ts) and the produce stage runs (jobs/handlers/produce-shot.ts).
//
// cartoon_generated is two calls: a style keyframe (image.keyframe), then a video (video.budget) that starts from it.
// stop_motion is 24 to 36 frame calls (image.edit) from the hero image, each reading the hero and the frame before it, then the
// closing component stopmotion.player. The player is a component, not a call, so the contract's chain does not carry it (v5 note).
//
// Prices follow the estimate's billing rule (budget/estimate.ts): a per-second price bills the shot's length times the takes, and a
// per-image or per-call price bills the takes. An unknown price (null, or a unit that cannot price one call) is never 0: the chain is
// unknown and the type is removed by rule 5, with the reason `unknown_price`.

import { COMPONENT_LIBRARY } from "../compose/components/index.ts";
import { framesNeeded } from "../compose/components/stopmotion.player/props.ts";
import { priceFor, prices, type PriceKey, type PriceUnit } from "../config/prices.ts";
import { roundUsd, sumUsd, type ModelClass, type VisualType } from "../contracts/index.ts";
import { STOP_MOTION_FPS, STOP_MOTION_FRAMES } from "./tables.ts";

/** A value or the reason it cannot be built. Used by the chain builders and the timing helpers. */
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The visual types whose source is a chain of calls (contract v5). */
export const CHAIN_TYPES = ["cartoon_generated", "stop_motion"] as const;
export type ChainType = (typeof CHAIN_TYPES)[number];

export function isChainType(visualType: VisualType): visualType is ChainType {
  return (CHAIN_TYPES as readonly string[]).includes(visualType);
}

/** The component that draws a chain's frames after its last call (7.1). It is a component, not a call, so the chain does not carry it. */
export const CLOSING_COMPONENT: Partial<Record<ChainType, string>> = {
  stop_motion: "stopmotion.player",
};

/** One call of a chain's shape: its output name, its model class and its take count. The prompt and the inputs come from the builder. */
export type ChainStep = { output: string; modelClass: ModelClass; takes: 1 };

/** The output name of frame n (1-based): frame_01 to frame_36. Lower case, so it is never an asset uri (contract v5). */
export function frameOutputName(number: number): string {
  return `frame_${String(number).padStart(2, "0")}`;
}

/**
 * The frame count and frame rate of a stop-motion shot (7.1). The rate is the top of the Bible's range, 12 per second: a whole
 * number the player accepts. The count is the count the clip needs at that rate, which is the player's own rule (framesNeeded), so
 * the planner and the component agree by construction. A shot that needs more than 36 frames, or fewer than 24, is refused with
 * that count. Nothing is clamped: a clamp would give the calls and the clip different timing.
 */
export function stopMotionTiming(durationMs: number): Checked<{ frames: number; fps: number }> {
  if (!(durationMs > 0)) {
    return { ok: false, reason: `a stop-motion shot needs a positive length, and this one is ${durationMs} ms` };
  }
  const fps = STOP_MOTION_FPS.max;
  const frames = framesNeeded(durationMs, fps);
  const seconds = durationMs / 1000;
  const allowed = `${STOP_MOTION_FRAMES.min} to ${STOP_MOTION_FRAMES.max} frames at ${fps} per second is about ${STOP_MOTION_FRAMES.min / fps} to ${STOP_MOTION_FRAMES.max / fps} seconds`;
  if (frames > STOP_MOTION_FRAMES.max) {
    return {
      ok: false,
      reason: `a stop-motion shot of ${seconds} seconds needs ${frames} frames at ${fps} per second, more than the ${STOP_MOTION_FRAMES.max} allowed (Bible 7.1): it is refused, not clamped (${allowed})`,
    };
  }
  if (frames < STOP_MOTION_FRAMES.min) {
    return {
      ok: false,
      reason: `a stop-motion shot of ${seconds} seconds needs ${frames} frames at ${fps} per second, fewer than the ${STOP_MOTION_FRAMES.min} allowed (Bible 7.1): lengthen the shot (${allowed})`,
    };
  }
  return { ok: true, value: { frames, fps } };
}

/** The calls of a chain type for a shot of durationMs, in order. Refused when the shot's length cannot be made (stop-motion bounds). */
export function chainStepsOf(visualType: ChainType, durationMs: number): Checked<ChainStep[]> {
  switch (visualType) {
    case "cartoon_generated":
      return {
        ok: true,
        value: [
          { output: "keyframe", modelClass: "image.keyframe", takes: 1 },
          { output: "clip", modelClass: "video.budget", takes: 1 },
        ],
      };
    case "stop_motion": {
      const timing = stopMotionTiming(durationMs);
      if (!timing.ok) return timing;
      return {
        ok: true,
        value: Array.from({ length: timing.value.frames }, (_, index) => ({
          output: frameOutputName(index + 1),
          modelClass: "image.edit" as const,
          takes: 1 as const,
        })),
      };
    }
  }
}

/** The price of one call: the route's price key, and its cost, or the reason it has none. */
export type CallPrice =
  | { known: true; routeKey: PriceKey; usd: number }
  | { known: false; routeKey: PriceKey; reason: string };

/** The billable units of one call (the estimate's rule, budget/estimate.ts billableUnits), or null when the unit cannot price one call. */
function unitsOf(unit: PriceUnit, durationMs: number, takes: number): number | null {
  switch (unit) {
    case "per_second":
      return (durationMs / 1000) * takes;
    case "per_image":
    case "per_call":
      return takes;
    default:
      return null;
  }
}

/** What one call costs for a shot of durationMs. Rounded to 4 decimals per call, as the estimate rounds each line. */
export function callPriceOf(step: ChainStep, durationMs: number): CallPrice {
  const routeKey = prices.routeFor[step.modelClass];
  const price = priceFor(routeKey);
  if (price.usd === null) {
    return { known: false, routeKey, reason: `unknown_price: ${routeKey} has no known price` };
  }
  const units = unitsOf(price.unit, durationMs, step.takes);
  if (units === null) {
    return {
      known: false,
      routeKey,
      reason: `unknown_price: ${routeKey} is priced ${price.unit}, which cannot price one call`,
    };
  }
  return { known: true, routeKey, usd: roundUsd(price.usd * units) };
}

/** A chain's price: the sum of its calls, or the first call whose price is unknown. */
export type ChainPrice =
  | { known: true; routeKey: PriceKey; calls: number; baseUsd: number }
  | { known: false; routeKey: PriceKey; reason: string };

export function chainPriceOf(visualType: ChainType, durationMs: number): ChainPrice {
  const steps = chainStepsOf(visualType, durationMs);
  if (!steps.ok) {
    return {
      known: false,
      routeKey: prices.routeFor["image.edit"],
      reason: `unknown_price: ${steps.reason}`,
    };
  }
  const calls = steps.value.map((step) => callPriceOf(step, durationMs));
  const unknown = calls.find((call): call is Extract<CallPrice, { known: false }> => !call.known);
  if (unknown !== undefined) {
    return {
      known: false,
      routeKey: unknown.routeKey,
      reason: `${unknown.reason} (the chain makes ${calls.length} calls)`,
    };
  }
  const usd = calls.flatMap((call) => (call.known ? [call.usd] : []));
  const first = calls[0];
  if (first === undefined)
    return {
      known: false,
      routeKey: prices.routeFor["image.keyframe"],
      reason: "unknown_price: the chain has no calls",
    };
  return { known: true, routeKey: first.routeKey, calls: calls.length, baseUsd: sumUsd(usd) };
}

/** The closing component of a visual type, or undefined when its shot has none (every type but the stop-motion chain). */
export function closingComponentOf(visualType: VisualType): string | undefined {
  return isChainType(visualType) ? CLOSING_COMPONENT[visualType] : undefined;
}

/** Whether the component library draws a component of this name (the library is data; a missing name is not drawn). */
export function libraryHas(component: string): boolean {
  return Object.hasOwn(COMPONENT_LIBRARY, component);
}

/**
 * Why a chain's closing component cannot be drawn yet, or null when it can. The library is injected so the check can be tested with
 * and without the component. A type whose closing component is missing is removed by rule 6 (a source that cannot be built).
 */
export function closingComponentProblem(
  visualType: VisualType,
  has: (component: string) => boolean = libraryHas,
): string | null {
  const component = closingComponentOf(visualType);
  if (component === undefined || has(component)) return null;
  return `the closing component ${component} is not in the component library yet, so the frames would have no player`;
}
