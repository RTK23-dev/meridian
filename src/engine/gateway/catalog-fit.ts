// Which catalog candidates fit one paid call (Bible 10.5 step 1), and in what order they are offered (step 4). Pure.
//
// A candidate fits when it serves the call's model class, is priced in a unit the engine can estimate that class from (a video or
// avatar call per second, an image per image or per request, speech per request), and its capabilities cover the need: the
// duration, the 9:16 aspect and the resolution for a video call, a first or last frame when the call has one, the reference count,
// and audio when the call wants it. A capability the catalog leaves unknown (null) never counts as "yes": a need that depends on
// it is refused with an "unknown" reason. Every refusal names its reason, so the director and the user can see why.

import type { CatalogPriceUnit, ModelCatalogEntry } from "../contracts/catalog.ts";
import type { ModelClass } from "../contracts/plan.ts";
import { modelPreferences } from "../config/model-preferences.ts";

/** What one paid call needs from its model. Built from the call's asset spec (assets/model-choice.ts needOf). */
export type ModelNeed = {
  modelClass: ModelClass;
  /** The call's length in seconds. Checked for the timed classes (video, avatar, lip-sync) only. */
  durationSeconds: number;
  aspect: "9:16";
  /** The resolution a video call is made at, or null when the class has none. */
  resolution: string | null;
  firstFrame: boolean;
  lastFrame: boolean;
  /** Reference images the call sends. */
  refCount: number;
  /** Whether the call wants the model's own audio. The engine's voice track is the clock, so a video call does not. */
  audio: boolean;
};

export const REJECTION_REASONS = [
  "model_class",
  "price_unit",
  "duration_unknown",
  "duration_outside",
  "aspect_unknown",
  "aspect_unsupported",
  "resolution_unknown",
  "resolution_unsupported",
  "first_frame_unknown",
  "first_frame_unsupported",
  "last_frame_unknown",
  "last_frame_unsupported",
  "refs_unknown",
  "refs_exceeded",
  "audio_unknown",
  "audio_unsupported",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type CandidateRejection = { id: string; reason: RejectionReason; detail: string };

export type CandidateFit = { eligible: ModelCatalogEntry[]; rejected: CandidateRejection[] };

const TIMED: ReadonlySet<ModelClass> = new Set(["video.cinematic", "video.budget", "video.i2v_pinned", "avatar", "lipsync"]);

/** Whether a class is billed by the second, and so needs a duration and a per-second price. */
export function isTimedClass(modelClass: ModelClass): boolean {
  return TIMED.has(modelClass);
}

/** The price units a call of each class can be estimated from before it is made. Lip-sync has none yet (its vendor is open). */
export const ESTIMABLE_UNITS: Readonly<Record<ModelClass, readonly CatalogPriceUnit[]>> = {
  "video.cinematic": ["per_second"],
  "video.budget": ["per_second"],
  "video.i2v_pinned": ["per_second"],
  avatar: ["per_second"],
  "image.keyframe": ["per_image", "per_request"],
  "image.edit": ["per_image", "per_request"],
  tts: ["per_request"],
  lipsync: [],
};

/** Why an entry does not fit the need, or null when it fits. The first failing check is the reason. */
export function rejectionOf(need: ModelNeed, entry: ModelCatalogEntry): { reason: RejectionReason; detail: string } | null {
  if (!entry.modelClasses.includes(need.modelClass)) {
    return { reason: "model_class", detail: `serves ${entry.modelClasses.join(", ")}, not ${need.modelClass}` };
  }
  const units = ESTIMABLE_UNITS[need.modelClass];
  if (!units.includes(entry.price.unit)) {
    return { reason: "price_unit", detail: `priced ${entry.price.unit}; a ${need.modelClass} call is estimated ${units.length > 0 ? units.join(" or ") : "from no catalog unit yet"}` };
  }
  const caps = entry.capabilities;
  if (isTimedClass(need.modelClass)) {
    if (caps.minSeconds === null || caps.maxSeconds === null) return { reason: "duration_unknown", detail: "the catalog does not list its durations" };
    if (need.durationSeconds < caps.minSeconds || need.durationSeconds > caps.maxSeconds) {
      return { reason: "duration_outside", detail: `${need.durationSeconds} s is outside ${caps.minSeconds} to ${caps.maxSeconds} s` };
    }
    if (caps.aspectRatios === null) return { reason: "aspect_unknown", detail: "the catalog does not list its aspect ratios" };
    if (!caps.aspectRatios.includes(need.aspect)) return { reason: "aspect_unsupported", detail: `does not list ${need.aspect}` };
  }
  if (need.resolution !== null) {
    if (caps.resolutions === null) return { reason: "resolution_unknown", detail: "the catalog does not list its resolutions" };
    if (!caps.resolutions.includes(need.resolution)) return { reason: "resolution_unsupported", detail: `does not list ${need.resolution}` };
  }
  if (need.firstFrame) {
    if (caps.firstFrame === null) return { reason: "first_frame_unknown", detail: "the catalog does not say whether it takes a first frame" };
    if (!caps.firstFrame) return { reason: "first_frame_unsupported", detail: "takes no first frame" };
  }
  if (need.lastFrame) {
    if (caps.lastFrame === null) return { reason: "last_frame_unknown", detail: "the catalog does not say whether it takes a last frame" };
    if (!caps.lastFrame) return { reason: "last_frame_unsupported", detail: "takes no last frame" };
  }
  if (need.refCount > 0) {
    if (caps.refsMax === null) return { reason: "refs_unknown", detail: `the catalog does not say how many references it takes; the call sends ${need.refCount}` };
    if (need.refCount > caps.refsMax) return { reason: "refs_exceeded", detail: `takes ${caps.refsMax} references; the call sends ${need.refCount}` };
  }
  if (need.audio) {
    if (caps.audio === null) return { reason: "audio_unknown", detail: "the catalog does not say whether it makes audio" };
    if (!caps.audio) return { reason: "audio_unsupported", detail: "makes no audio" };
  }
  return null;
}

/** The candidates that fit a need, in catalog order, and a reason for each one that does not. */
export function eligibleCandidates(need: ModelNeed, entries: readonly ModelCatalogEntry[]): CandidateFit {
  const eligible: ModelCatalogEntry[] = [];
  const rejected: CandidateRejection[] = [];
  for (const entry of entries) {
    const rejection = rejectionOf(need, entry);
    if (rejection === null) eligible.push(entry);
    else rejected.push({ id: entry.id, ...rejection });
  }
  return { eligible, rejected };
}

/**
 * The ranking hook of Bible 10.5 step 4: the class's preferred ids first, in preference order, then the rest in catalog order. It
 * only reorders; it never adds or removes a candidate. The table starts empty (config/model-preferences.ts), so for now the order
 * is the catalog's.
 */
export function rankCandidates(
  modelClass: ModelClass,
  eligible: readonly ModelCatalogEntry[],
  ranked: Readonly<Partial<Record<ModelClass, readonly string[]>>> = modelPreferences.ranked,
): ModelCatalogEntry[] {
  const preferred = ranked[modelClass] ?? [];
  if (preferred.length === 0) return [...eligible];
  const position = (id: string): number => {
    const at = preferred.indexOf(id);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  return eligible
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => position(a.entry.id) - position(b.entry.id) || a.index - b.index)
    .map(({ entry }) => entry);
}
