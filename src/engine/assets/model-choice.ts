// The orchestrator's model choice for one paid call (Bible 10.5 steps 2, 3 and 5; contract v7 AssetSpec.modelChoice). Pure.
//
// needOf          what an asset spec needs from its model (the eligibility filter's input, gateway/catalog-fit.ts).
// resolveModelChoice
//                 turns the director's answer for one call into the spec's modelChoice and the shot's Decision. The answer is
//                 untrusted: an id is accepted only when it is one of that call's eligible candidates. Otherwise, or with no
//                 answer (the role failed or was refused), the call uses the first route-table target (config/routes.ts) that is
//                 among its eligible candidates, recorded with source "fallback" and the reason. With no eligible fallback either,
//                 no choice is made: modelChoice stays null and the route table applies exactly as before v7.
// catalogEstimateUsd
//                 the estimate of one call from its catalog price (step 5). It is rounded up to the cent's hundredth, so a
//                 reservation never holds less than the list rate; the bill is still OpenRouter's usage.cost.

import { EngineError } from "../contracts/errors.ts";
import { MODEL_CHOICE_REASON_MAX, type AssetSpec, type ModelChoice } from "../contracts/assets.ts";
import type { ModelCatalogEntry } from "../contracts/catalog.ts";
import type { Decision } from "../contracts/plan.ts";
import type { ModelNeed } from "../gateway/catalog-fit.ts";
import { isVideoClass, VIDEO_RESOLUTION } from "./providers/openrouterVideo.ts";

const MICRO_PER_USD = 10_000;

/** What a spec needs from its model. The engine never asks a video model for its own audio: the voice track is the clock (Bible 1). */
export function needOf(spec: AssetSpec): ModelNeed {
  return needFor({
    modelClass: spec.modelClass,
    durationMs: spec.durationMs,
    firstFrame: spec.firstFrame !== undefined,
    lastFrame: spec.lastFrame !== undefined,
    refCount: spec.refs.length,
  });
}

/** The same need, from the parts of a call a plan already names (before its asset spec is built at produce time). */
export function needFor(call: { modelClass: AssetSpec["modelClass"]; durationMs: number; firstFrame: boolean; lastFrame: boolean; refCount: number }): ModelNeed {
  return {
    modelClass: call.modelClass,
    durationSeconds: call.durationMs / 1000,
    aspect: "9:16",
    resolution: isVideoClass(call.modelClass) ? VIDEO_RESOLUTION : null,
    firstFrame: call.firstFrame,
    lastFrame: call.lastFrame,
    refCount: call.refCount,
    audio: false,
  };
}

/** USD rounded up to four decimals. A tiny positive amount is at least 0.0001, never 0. */
function ceilUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new EngineError("invalid_input", `a catalog estimate must be finite and >= 0, got ${String(value)}`);
  return Math.ceil(value * MICRO_PER_USD - 1e-9) / MICRO_PER_USD;
}

/**
 * The estimate of one call from its catalog price. A per-second price is multiplied by the spec's seconds; a per-image or
 * per-request price is one unit (each call makes one image, or one request). A per-token price throws unknown_price: the tokens of a
 * call are not known before it is made, so it is never estimated.
 */
export function catalogEstimateUsd(entry: ModelCatalogEntry, spec: AssetSpec): number {
  return catalogCallUsd(entry, spec.durationMs);
}

/** The same estimate from a call's length, for estimate_reserve, which prices calls before their specs exist. */
export function catalogCallUsd(entry: ModelCatalogEntry, durationMs: number): number {
  switch (entry.price.unit) {
    case "per_second":
      return ceilUsd(entry.price.usd * (durationMs / 1000));
    case "per_image":
    case "per_request":
      return ceilUsd(entry.price.usd);
    case "per_token":
      throw new EngineError("unknown_price", `${entry.id} is priced per token, so a call cannot be estimated before it is made`);
  }
}

/** The director's answer for one call. Untrusted model output: it is checked, never acted on as an instruction. */
export type DirectorPick = { modelId: string; reason: string };

export type ResolveInput = {
  modelClass: AssetSpec["modelClass"];
  /** The call's eligible candidates (already filtered and ranked), as the director was shown them. */
  eligible: readonly ModelCatalogEntry[];
  /** The director's pick for this call, or null when it gave none. */
  pick: DirectorPick | null;
  /** Why there is no usable pick, when the role failed, was refused, or left the call out. */
  failure: string | null;
  /** The fallback models, in priority order. The chooser passes the call's eligible catalog candidates, ranked. */
  fallbackModels: readonly string[];
  catalogReadAt: string;
  /** The decision time (ISO). */
  at: string;
};

export type ResolvedChoice = { modelChoice: ModelChoice | null; decision: Decision };

/** Model text kept as data: one line, no control characters, within the contract's length. */
function dataText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function bounded(reason: string): string {
  return dataText(reason, MODEL_CHOICE_REASON_MAX);
}

/** The choice for one call, and the Decision that records it (Bible 10.5 steps 2 and 3, L7). */
export function resolveModelChoice(input: ResolveInput): ResolvedChoice {
  const ids = input.eligible.map((entry) => entry.id);
  const shown = ids.length === 0 ? "no eligible candidate" : `${ids.length} eligible candidate${ids.length === 1 ? "" : "s"}`;
  const readNote = `catalog read at ${input.catalogReadAt}`;

  if (input.pick !== null && ids.includes(input.pick.modelId)) {
    const why = dataText(input.pick.reason, MODEL_CHOICE_REASON_MAX) || "the director gave no reason";
    const modelChoice: ModelChoice = {
      provider: "openrouter",
      modelId: input.pick.modelId,
      source: "orchestrator",
      reason: bounded(why),
      catalogReadAt: input.catalogReadAt,
    };
    return {
      modelChoice,
      decision: {
        at: input.at,
        chose: `openrouter:${input.pick.modelId}`,
        alternatives: [],
        reason: `the director chose it from ${shown} (${readNote}): ${why}`,
        by: "director",
      },
    };
  }
  const refusal =
    input.pick !== null
      ? `the director's pick ${dataText(input.pick.modelId, 120)} is not one of this call's eligible candidates, so it is refused`
      : (input.failure ?? "the director gave no pick for this call");

  const fallback = input.fallbackModels.find((model) => ids.includes(model)) ?? null;
  if (fallback === null) {
    return {
      modelChoice: null,
      decision: {
        at: input.at,
        chose: `no model for ${input.modelClass}`,
        alternatives: [],
        reason: `${refusal}; no eligible candidate for ${input.modelClass} is among the ${shown} (${readNote}), so no model is chosen and the call is left out`,
        by: "scorer",
      },
    };
  }
  const reason = `${refusal}; the first eligible catalog candidate for ${input.modelClass} is used`;
  return {
    modelChoice: { provider: "openrouter", modelId: fallback, source: "fallback", reason: bounded(reason), catalogReadAt: input.catalogReadAt },
    decision: { at: input.at, chose: `openrouter:${fallback}`, alternatives: [], reason: `${reason} (${shown}, ${readNote})`, by: "scorer" },
  };
}
