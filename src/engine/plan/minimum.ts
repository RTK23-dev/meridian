// The format minimum of a master (Bible 6.1 step 6, 14.2 and 14.4): the fixed per-master lines plus the cheapest plan that
// covers the request's beats. Pure code. Every option is priced with the planner's cost model (cost.ts) and filtered with
// the planner's kit and product rules (filter.ts), so a budget at the minimum is priced the way the planner prices a plan.
//
// Public entry point: minimumMasterBudgetUsd(input) returns { minimumUsd, lines }. Lines sum to minimumUsd, so a UI can show
// the breakdown. An unknown price is refused with an EngineError of kind unknown_price, never treated as 0.
//
// What the minimum does not know, because intake runs before analysis and planning: which reference shot each beat mirrors,
// so every visual type is an option for a beat with no `must`; and which beats show the product or hold text (rules 2 to 4
// of 7.2 that depend on them). Those choices only remove generated options, so the minimum is never higher than the
// planner's cheapest plan for the same beat durations. Beat durations are estimates (words divided by words per minute,
// 6.1 step 4). The voice's real timings can move a generated shot's cost, and the plan gate then decides.

import { budgets } from "../config/budgets.ts";
import {
  EngineError,
  VISUAL_TYPES,
  sumUsd,
  type CharacterSheet,
  type Persona,
  type ProductKit,
  type VisualType,
} from "../contracts/index.ts";
import { planTotals, shotCost, usdUnits, type KnownShotCost, type ShotCost } from "./cost.ts";
import { kitRejection, mustAllowedTypes, mustShowsProduct, productPixelRejection } from "./filter.ts";
import { productImageUris } from "./product.ts";
import { RECIPES, KIT_REQUIREMENTS, visualPropertySchema, type VisualProperty } from "./tables.ts";
import type { ClassifiedRequest, PlanKits } from "./types.ts";

/** A script beat as the minimum reads it: its id and its text. The spoken length is estimated from the text. */
export type MinimumBeat = { beatId: string; text: string };

/** One visual request of the request (7.3). Only `must` requests can change the minimum. */
export type MinimumRequest = { beatId: string; want: string; strength: "must" | "may" };

/** The classification of a visual request (7.3), keyed by beat and request text, as request.ts keys it. */
export type MinimumClassification = { beatId: string; want: string; properties: readonly VisualProperty[] };

export type MinimumInput = {
  /** The script beats in order. */
  beats: readonly MinimumBeat[];
  /** The voice's speaking rate (Persona.wordsPerMinute). Must be a positive, finite number. */
  wordsPerMinute: number;
  /** The request's visual requests. A `may` adds options only, so it never raises the minimum. */
  visualRequests: readonly MinimumRequest[];
  /** The classification of every `must` request. A must without one is refused. */
  classifications: readonly MinimumClassification[];
  /** Which kits resolved (7.2 rule 6). Use planKitsOf to build it from the kit bodies. */
  kits: PlanKits;
};

/** One line of the breakdown: a fixed per-master stage, a beat's cheapest shot, or the redo allowance. */
export type MinimumLine = { label: string; usd: number; beatId?: string; visualType?: VisualType };

export type MasterMinimum = {
  /** The fixed per-master lines, plus the cheapest shot of every beat, plus the redo allowance on generated shots. */
  minimumUsd: number;
  /** The breakdown. Its usd values sum to minimumUsd. */
  lines: MinimumLine[];
};

const REDO_ALLOWANCE_LABEL = "redo_allowance";
const MS_PER_MINUTE = 60_000;
const WORD = /\S+/g;
const KIND_RANK: Record<(typeof RECIPES)[VisualType]["kind"], number> = { component: 0, stock: 1, generate: 2 };

/**
 * The spoken length of each beat in milliseconds: words divided by words per minute (6.1 step 4). Throws invalid_input for a
 * speaking rate that is not positive and finite, and for a beat with no words, which has no spoken length to price.
 */
export function spokenBeatMs(beats: readonly MinimumBeat[], wordsPerMinute: number): number[] {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    throw new EngineError("invalid_input", "wordsPerMinute must be a positive, finite number");
  }
  return beats.map((beat) => {
    const words = beat.text.match(WORD)?.length ?? 0;
    if (words === 0) {
      throw new EngineError("invalid_input", `beat ${beat.beatId} has no words, so it has no spoken length to price`);
    }
    return Math.round((words * MS_PER_MINUTE) / wordsPerMinute);
  });
}

/**
 * The plan kits (7.2 rule 6) that a request resolved to, from the kit bodies that loaded. A kit that did not load is simply
 * absent from the input, so its flag is false. A product kit with no image cannot pin a hero frame, so it counts as absent
 * (product.ts).
 */
export function planKitsOf(kits: { persona?: Persona; productKit?: ProductKit; characters: readonly CharacterSheet[] }): PlanKits {
  return {
    persona: kits.persona !== undefined,
    rigCharacter: kits.characters.some((item) => item.kind === "rigged_svg"),
    generatedCharacter: kits.characters.some((item) => item.kind === "generated"),
    productKit: kits.productKit !== undefined && productImageUris(kits.productKit).length > 0,
  };
}

type Option = { visualType: VisualType; cost: ShotCost };
type KnownOption = { visualType: VisualType; cost: KnownShotCost };

/** Known prices first by USD units, then code before stock before generation, then fewest kit needs, then VISUAL_TYPES order. */
function compareKnown(a: KnownOption, b: KnownOption): number {
  const byCost = usdUnits(a.cost.totalUsd) - usdUnits(b.cost.totalUsd);
  if (byCost !== 0) return byCost;
  const byKind = KIND_RANK[RECIPES[a.visualType].kind] - KIND_RANK[RECIPES[b.visualType].kind];
  if (byKind !== 0) return byKind;
  const byNeeds = KIT_REQUIREMENTS[a.visualType].length - KIT_REQUIREMENTS[b.visualType].length;
  if (byNeeds !== 0) return byNeeds;
  return VISUAL_TYPES.indexOf(a.visualType) - VISUAL_TYPES.indexOf(b.visualType);
}

/**
 * The cheapest option of one beat. Refused (unknown_price) when no option has a known price, and when the cheapest known
 * option costs more than nothing while an option with an unknown price could be cheaper. An unknown price is never 0.
 * Exported so the refusal rule can be tested with options no current price table produces.
 */
export function cheapestOption(beatId: string, options: readonly Option[]): KnownOption {
  if (options.length === 0) {
    throw new EngineError("invalid_input", `no visual type can cover beat ${beatId}`);
  }
  const known: KnownOption[] = [];
  const unknown: string[] = [];
  for (const option of options) {
    if (option.cost.known) {
      known.push({ visualType: option.visualType, cost: option.cost });
    } else {
      unknown.push(`${option.visualType} (${option.cost.reason})`);
    }
  }
  let best: KnownOption | undefined;
  for (const candidate of known) {
    if (best === undefined || compareKnown(candidate, best) < 0) {
      best = candidate;
    }
  }
  if (best === undefined) {
    throw new EngineError(
      "unknown_price",
      `beat ${beatId}: no visual type has a known price (${unknown.join("; ")}); the minimum refuses to guess`,
    );
  }
  if (usdUnits(best.cost.totalUsd) > 0 && unknown.length > 0) {
    throw new EngineError(
      "unknown_price",
      `beat ${beatId}: ${best.visualType} costs ${best.cost.totalUsd} USD, but ${unknown.join("; ")} has an unknown price and could be cheaper; the minimum refuses to guess`,
    );
  }
  return best;
}

/** The options of one beat: every allowed type that passes rules 2 and 6 of 7.2 (the rules that do not need a price). */
function optionsFor(allowed: readonly VisualType[], durationMs: number, showsProduct: boolean, kits: PlanKits): Option[] {
  const options: Option[] = [];
  for (const visualType of allowed) {
    if (productPixelRejection(visualType, showsProduct, kits.productKit) !== null) continue;
    if (kitRejection(visualType, kits) !== null) continue;
    options.push({ visualType, cost: shotCost(visualType, durationMs) });
  }
  return options;
}

/**
 * The format minimum: the fixed per-master lines (14.2) plus the cheapest shot of every beat, with the redo allowance on
 * generated shots (6.5). Throws EngineError: invalid_input when the input cannot be priced (no words per minute, a must
 * without a classification, a must no type can deliver, a beat no type can cover), and unknown_price when a price the minimum
 * needs is unknown. A caller that gets a throw must not treat the minimum as known.
 */
export function minimumMasterBudgetUsd(input: MinimumInput): MasterMinimum {
  if (input.beats.length === 0) {
    throw new EngineError("invalid_input", "the minimum needs at least one beat");
  }
  const durations = spokenBeatMs(input.beats, input.wordsPerMinute);
  const beatIds = new Set(input.beats.map((beat) => beat.beatId));
  for (const request of input.visualRequests) {
    if (request.strength === "must" && !beatIds.has(request.beatId)) {
      throw new EngineError("invalid_input", `must "${request.want}" names beat ${request.beatId}, which the script does not have`);
    }
  }

  const shots = input.beats.map((beat, index) => {
    const classified = classifiedMustsOf(input, beat.beatId);
    const allowed = mustAllowedTypes(classified);
    if (allowed !== null && allowed.length === 0) {
      throw new EngineError("invalid_input", `no visual type can deliver the must request on beat ${beat.beatId}`);
    }
    const options = optionsFor(allowed ?? VISUAL_TYPES, durations[index], mustShowsProduct(classified), input.kits);
    return { beatId: beat.beatId, durationMs: durations[index], option: cheapestOption(beat.beatId, options) };
  });

  const totals = planTotals(shots.map((shot) => ({ baseUsd: shot.option.cost.baseUsd, generated: shot.option.cost.generated })));
  const lines: MinimumLine[] = [
    { label: budgets.fixedStages.claudeRoles, usd: budgets.fixedPerMasterUsd.claudeRoles },
    { label: budgets.fixedStages.critic, usd: budgets.fixedPerMasterUsd.critic },
    { label: budgets.fixedStages.render, usd: budgets.fixedPerMasterUsd.render },
    { label: budgets.fixedStages.media, usd: budgets.fixedPerMasterUsd.speechAndFfmpeg },
  ];
  for (const shot of shots) {
    lines.push({
      label: `${shot.beatId}: ${shot.option.visualType}`,
      usd: shot.option.cost.baseUsd,
      beatId: shot.beatId,
      visualType: shot.option.visualType,
    });
  }
  if (totals.allowanceUsd > 0) {
    lines.push({ label: REDO_ALLOWANCE_LABEL, usd: totals.allowanceUsd });
  }

  const minimumUsd = totals.reservedUsd;
  if (usdUnits(sumUsd(lines.map((line) => line.usd))) !== usdUnits(minimumUsd)) {
    throw new EngineError("internal", "the minimum breakdown does not sum to the minimum");
  }
  return { minimumUsd, lines };
}

/** The must requests of one beat, each with its classification. A must without one, or with unknown properties, is refused. */
function classifiedMustsOf(input: MinimumInput, beatId: string): ClassifiedRequest[] {
  const classified: ClassifiedRequest[] = [];
  for (const request of input.visualRequests) {
    if (request.beatId !== beatId || request.strength !== "must") continue;
    const found = input.classifications.find((item) => item.beatId === beatId && item.want === request.want);
    if (found === undefined) {
      throw new EngineError("invalid_input", `must "${request.want}" on beat ${beatId} has no classification, so the minimum cannot be priced`);
    }
    const properties = visualPropertySchema.array().safeParse(found.properties);
    if (!properties.success) {
      throw new EngineError("invalid_input", `the classification of must "${request.want}" names a property the planner does not know`);
    }
    classified.push({ strength: "must", want: request.want, properties: properties.data });
  }
  return classified;
}
