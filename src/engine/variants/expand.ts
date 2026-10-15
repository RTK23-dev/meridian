// The variant matrix, expanded (Video Engine Bible 6.13, 14.3). Pure: it reads the request, the scene plan and the master EDL, and
// returns one planned variant for each value of the matrix, with the one attribute it changes against the master (its control),
// the work it needs, and its cost estimate. It makes no call and writes nothing. The handler (jobs/handlers/variants.ts) acts on
// the plan: a caption or music variant is an EDL diff and is built now; every other variant needs generation and is reported.
//
// Work by attribute (Bible 6.13):
// - caption and music: an EDL diff and a re-render. No generation.
// - hook: a new hook line (variant_writer, the check route), the voice stage for that beat, and the generated shots in the hook beat.
// - product: produce_shot again for the product shots only (shots of visual type product_hero).
// - persona: the voice stage for the whole script and the presenter shots (ugc_presenter) produced again.
// - language: the writer for every beat, the voice stage for the whole script, and the presenter shots produced again.
//
// Fit (Bible 14.3): the cheapest variants go first, so the most variants fit the budget. Limits: the matrix's maxVariants, its
// budgetUsd, and what the variants may spend: the reservation's headroom (what it already holds beyond what is committed) plus what
// the request budget lets the reservation grow by (extendableUsd, variants/reserve.ts). Each limit that binds is named.

import { budgets } from "../config/budgets.ts";
import { EngineError, roundUsd, sumUsd, type EditDecisionList, type ProductionRequest, type ScenePlan, type VariantMatrix } from "../contracts/index.ts";
import { ATTRIBUTE_ORDER, CAPTION_BANDS, type CaptionBand, type VariantAttribute } from "./config.ts";

/** A music track the matrix names, as the handler loaded it. Missing tracks are not in the map, and the variant is skipped. */
export type VariantMusicTrack = { trackId: string; uri: string; durationMs: number };

/** The one change a variant makes. Its kind is the attribute. A hook index is 1-based. */
export type VariantChange =
  | { kind: "caption"; band: CaptionBand }
  | { kind: "music"; track: VariantMusicTrack }
  | { kind: "hook"; index: number }
  | { kind: "product"; sku: string }
  | { kind: "persona"; personaId: string }
  | { kind: "language"; language: string };

/** What a variant needs from the generation stages. Empty lists mean no work of that kind. */
export type VariantWork = {
  /** Shots whose generated take is made again (produce_shot, Bible 6.6). */
  produceShotIds: string[];
  /** Beats whose new narration the voice stage speaks (Bible 6.3). */
  voiceBeatIds: string[];
  /** Beats whose new line the variant writer writes (variant_writer, Bible 11.1). */
  writerBeatIds: string[];
};

export type PlannedVariant = {
  /** Unique within the request: the attribute and the value, for example "caption:upper" or "hook:2". */
  key: string;
  attribute: VariantAttribute;
  value: string;
  change: VariantChange;
  /** The master EDL and the one attribute the variant changes: the value it has in the master and the value it has in the variant. */
  control: { edlId: string; from: string | null; to: string | null };
  /** The list-price estimate of the variant (Bible 14.3, the high end). */
  estimateUsd: number;
  /** "rerender": an EDL diff and a render only. "generation": needs produce, voice or the writer, so it is not built in the variants stage. */
  build: "rerender" | "generation";
  work: VariantWork;
};

export type SkipReason =
  | "caption_not_drawable"
  | "music_track_unknown"
  | "music_too_short"
  | "no_hook_beat"
  | "duplicate_value"
  | "over_max_variants"
  | "over_budget"
  | "over_reservation"
  | "over_request_budget";

export type SkippedVariant = {
  key: string;
  attribute: VariantAttribute;
  value: string;
  reason: SkipReason;
  estimateUsd: number;
};

export type VariantExpansion = {
  /** The variants that fit, cheapest first, in the order the fit took them. */
  planned: PlannedVariant[];
  skipped: SkippedVariant[];
  /** The exact sum of the planned estimates. */
  estimateUsd: number;
  /** The budget the fit used: the matrix's budgetUsd, or the reservation's headroom when that is lower. */
  budgetUsd: number;
};

export type ExpansionInput = {
  request: ProductionRequest;
  plan: ScenePlan;
  master: EditDecisionList;
  matrix: VariantMatrix;
  /** The music tracks of the matrix that the handler found. A matrix id missing from this map is skipped as unknown. */
  tracks: ReadonlyMap<string, VariantMusicTrack>;
  /** What the request's reservation can still hold: its reservedUsd less what is committed. Never negative. */
  headroomUsd: number;
  /**
   * How much the reservation may be raised under the request budget: constraints.budgetUsd less its reservedUsd. Never negative. Absent
   * means zero, so the variants fit the headroom alone.
   */
  extendableUsd?: number;
};

const COST = budgets.variantCostUsd;

/** The list-price estimate of one variant of an attribute (Bible 14.3, high end, from config/budgets.ts). */
export function estimateFor(attribute: VariantAttribute): number {
  switch (attribute) {
    case "caption":
      return COST.captionOrText.high;
    case "music":
      return COST.musicSwap.high;
    case "hook":
      return COST.newHookLine.high;
    case "product":
      return COST.productSwap.high;
    case "persona":
    case "language":
      return COST.newPersonaOrLanguage.high;
  }
}

function isBand(value: string): value is CaptionBand {
  return (CAPTION_BANDS as readonly string[]).includes(value);
}

/** The caption band of the master: the band of its first caption clip that names one, or null when none does (unknown stays null). */
export function masterBand(master: EditDecisionList): CaptionBand | null {
  for (const track of master.tracks) {
    if (track.layer !== "captions") continue;
    for (const clip of track.clips) {
      const band = clip.props?.band;
      if (typeof band === "string" && isBand(band)) return band;
    }
  }
  return null;
}

const NO_WORK: VariantWork = { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] };

function isGenerated(shot: ScenePlan["shots"][number]): boolean {
  return shot.source.kind === "generate";
}

function shotsWhere(plan: ScenePlan, predicate: (shot: ScenePlan["shots"][number]) => boolean): string[] {
  return plan.shots.filter(predicate).map((shot) => shot.shotId);
}

/** The work an attribute needs, or null when the request has no beat for it (a hook without a hook beat). */
export function workFor(attribute: VariantAttribute, request: ProductionRequest, plan: ScenePlan): VariantWork | null {
  const beatIds = request.script.beats.map((beat) => beat.beatId);
  switch (attribute) {
    case "caption":
    case "music":
      return NO_WORK;
    case "hook": {
      const hook = request.script.beats.find((beat) => beat.role === "hook");
      if (hook === undefined) return null;
      return {
        produceShotIds: shotsWhere(plan, (shot) => shot.beatId === hook.beatId && isGenerated(shot)),
        voiceBeatIds: [hook.beatId],
        writerBeatIds: [hook.beatId],
      };
    }
    case "product":
      return {
        produceShotIds: shotsWhere(plan, (shot) => shot.visualType === "product_hero" && isGenerated(shot)),
        voiceBeatIds: [],
        writerBeatIds: [],
      };
    case "persona":
      return {
        produceShotIds: shotsWhere(plan, (shot) => shot.visualType === "ugc_presenter" && isGenerated(shot)),
        voiceBeatIds: beatIds,
        writerBeatIds: [],
      };
    case "language":
      return {
        produceShotIds: shotsWhere(plan, (shot) => shot.visualType === "ugc_presenter" && isGenerated(shot)),
        voiceBeatIds: beatIds,
        writerBeatIds: beatIds,
      };
  }
}

/** One planned variant. Its build follows from its attribute: caption and music re-render, every other attribute needs generation. */
function plannedVariant(input: {
  attribute: VariantAttribute;
  value: string;
  change: VariantChange;
  from: string | null;
  to: string | null;
  work: VariantWork;
  masterEdlId: string;
}): PlannedVariant {
  return {
    key: `${input.attribute}:${input.value}`,
    attribute: input.attribute,
    value: input.value,
    change: input.change,
    control: { edlId: input.masterEdlId, from: input.from, to: input.to },
    estimateUsd: estimateFor(input.attribute),
    build: input.attribute === "caption" || input.attribute === "music" ? "rerender" : "generation",
    work: input.work,
  };
}

type Offer = { variant: PlannedVariant; order: number };

/** Expands the matrix into planned and skipped variants, and fits them to the limits. Pure: same input, same output. */
export function expandVariants(input: ExpansionInput): VariantExpansion {
  if (!Number.isFinite(input.headroomUsd) || input.headroomUsd < 0) {
    throw new EngineError("invalid_input", "the reservation headroom must be a finite amount, zero or more", { stage: "variants" });
  }
  const { request, plan, master, matrix } = input;
  const edlId = master.edlId;
  const skipped: SkippedVariant[] = [];
  const offers: Offer[] = [];
  const seen = new Set<string>();

  // Each value is offered once. A value that cannot be made (not drawable, no track, no beat) is a skip with its reason.
  const offer = (attribute: VariantAttribute, value: string, make: () => PlannedVariant | SkipReason): void => {
    const key = `${attribute}:${value}`;
    if (seen.has(key)) {
      skipped.push({ key, attribute, value, reason: "duplicate_value", estimateUsd: estimateFor(attribute) });
      return;
    }
    seen.add(key);
    const made = make();
    if (typeof made === "string") {
      skipped.push({ key, attribute, value, reason: made, estimateUsd: estimateFor(attribute) });
      return;
    }
    offers.push({ variant: made, order: offers.length });
  };

  for (const value of matrix.captionStyles ?? []) {
    offer("caption", value, () => {
      if (!isBand(value)) return "caption_not_drawable";
      return plannedVariant({
        attribute: "caption",
        value,
        change: { kind: "caption", band: value },
        from: masterBand(master),
        to: value,
        work: NO_WORK,
        masterEdlId: edlId,
      });
    });
  }

  for (const value of matrix.music ?? []) {
    offer("music", value, () => {
      const track = input.tracks.get(value);
      if (track === undefined) return "music_track_unknown";
      if (track.durationMs < master.durationMs) return "music_too_short";
      return plannedVariant({
        attribute: "music",
        value,
        change: { kind: "music", track },
        from: master.audio.music?.uri ?? null,
        to: track.trackId,
        work: NO_WORK,
        masterEdlId: edlId,
      });
    });
  }

  for (let index = 1; index <= (matrix.hooks ?? 0); index += 1) {
    offer("hook", String(index), () => {
      const work = workFor("hook", request, plan);
      if (work === null) return "no_hook_beat";
      const hook = request.script.beats.find((beat) => beat.role === "hook");
      return plannedVariant({
        attribute: "hook",
        value: String(index),
        change: { kind: "hook", index },
        from: hook?.text ?? null,
        to: null,
        work,
        masterEdlId: edlId,
      });
    });
  }

  for (const sku of matrix.products ?? []) {
    offer("product", sku, () =>
      plannedVariant({
        attribute: "product",
        value: sku,
        change: { kind: "product", sku },
        from: request.product?.sku ?? null,
        to: sku,
        work: workFor("product", request, plan) ?? NO_WORK,
        masterEdlId: edlId,
      }),
    );
  }

  for (const personaId of matrix.personas ?? []) {
    offer("persona", personaId, () =>
      plannedVariant({
        attribute: "persona",
        value: personaId,
        change: { kind: "persona", personaId },
        from: request.page.personaId ?? null,
        to: personaId,
        work: workFor("persona", request, plan) ?? NO_WORK,
        masterEdlId: edlId,
      }),
    );
  }

  for (const language of matrix.languages ?? []) {
    offer("language", language, () =>
      plannedVariant({
        attribute: "language",
        value: language,
        change: { kind: "language", language },
        from: request.script.language,
        to: language,
        work: workFor("language", request, plan) ?? NO_WORK,
        masterEdlId: edlId,
      }),
    );
  }

  // Fit: cheapest first, then the matrix's attribute order, then the order the matrix lists them in.
  const ranked = [...offers].sort(
    (a, b) =>
      a.variant.estimateUsd - b.variant.estimateUsd ||
      ATTRIBUTE_ORDER[a.variant.attribute] - ATTRIBUTE_ORDER[b.variant.attribute] ||
      a.order - b.order,
  );
  const extendableUsd = input.extendableUsd ?? 0;
  if (!Number.isFinite(extendableUsd) || extendableUsd < 0) {
    throw new EngineError("invalid_input", "the room the request budget leaves the reservation must be a finite amount, zero or more", { stage: "variants" });
  }
  // What the variants may spend: the headroom the reservation holds, and what the request budget lets it grow by.
  const spendableUsd = roundUsd(input.headroomUsd + extendableUsd);
  const reservationBinds = spendableUsd < matrix.budgetUsd;
  const budgetUsd = roundUsd(Math.min(matrix.budgetUsd, spendableUsd));
  const planned: PlannedVariant[] = [];
  for (const { variant } of ranked) {
    const skip = (reason: SkipReason): void => {
      skipped.push({ key: variant.key, attribute: variant.attribute, value: variant.value, reason, estimateUsd: variant.estimateUsd });
    };
    if (planned.length >= matrix.maxVariants) {
      skip("over_max_variants");
      continue;
    }
    const spent = sumUsd([...planned.map((item) => item.estimateUsd), variant.estimateUsd]);
    if (spent > budgetUsd) {
      // The reservation binds: the headroom alone, or the headroom plus a request budget that still leaves room (then the request
      // budget is what refuses the variant).
      if (!reservationBinds) skip("over_budget");
      else skip(extendableUsd > 0 ? "over_request_budget" : "over_reservation");
      continue;
    }
    planned.push(variant);
  }

  return {
    planned,
    skipped,
    estimateUsd: sumUsd(planned.map((variant) => variant.estimateUsd)),
    budgetUsd,
  };
}
