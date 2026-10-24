// The repurpose catalog (Meridian-owned). It names the treatment categories, their options and what each option sets in a cut's visual
// treatment (contract v11). Every number is a fraction of the option's full strength, so the intensity scales each option the same way. A
// category or option that Meridian cannot apply is listed as unavailable with its reason: it is never offered as a working control.

import type { LookPreset, VisualTreatment } from "../contracts/index.ts";

export const REPURPOSE_CATEGORIES = ["warp_rotation", "color_look", "frame_mirror", "texture_grain", "lighting", "text_overlay"] as const;
export type RepurposeCategory = (typeof REPURPOSE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<RepurposeCategory, string> = {
  warp_rotation: "Warp & rotation",
  color_look: "Color & look",
  frame_mirror: "Frame & mirror",
  texture_grain: "Texture & grain",
  lighting: "Lighting effects",
  text_overlay: "Text style & overlays",
};

/** The visual part one option sets, given the fraction of its full strength that the intensity applies (0 to 1). */
export type TreatmentPart = Partial<Pick<VisualTreatment, "look" | "framing" | "mirror" | "grain" | "vignette">>;

export type OptionAvailability = { available: true } | { available: false; reason: string };

export type TreatmentOption = {
  id: string;
  category: RepurposeCategory;
  label: string;
  availability: OptionAvailability;
  part: (fraction: number) => TreatmentPart;
};

const TEXT_OVERLAY_REASON =
  "Text overlays need timed text on the cut. No text overlay treatment is implemented in this release, so none is offered.";

export const OPTIONS: readonly TreatmentOption[] = [
  {
    id: "zoom_in",
    category: "warp_rotation",
    label: "Zoom in",
    availability: { available: true },
    part: (fraction) => ({ framing: { zoom: 1 + 0.12 * fraction, rotationDeg: 0, offsetXPct: 0, offsetYPct: 0 } }),
  },
  {
    id: "tilt",
    category: "warp_rotation",
    label: "Tilt",
    availability: { available: true },
    part: (fraction) => ({ framing: { zoom: 1, rotationDeg: 2 * fraction, offsetXPct: 0, offsetYPct: 0 } }),
  },
  {
    id: "drift",
    category: "warp_rotation",
    label: "Drift",
    availability: { available: true },
    part: (fraction) => ({ framing: { zoom: 1, rotationDeg: 0, offsetXPct: 3 * fraction, offsetYPct: -2 * fraction } }),
  },
  { id: "warm", category: "color_look", label: "Warm", availability: { available: true }, part: (fraction) => ({ look: { preset: "warm" as LookPreset, strength: fraction } }) },
  { id: "cool", category: "color_look", label: "Cool", availability: { available: true }, part: (fraction) => ({ look: { preset: "cool" as LookPreset, strength: fraction } }) },
  { id: "faded", category: "color_look", label: "Faded", availability: { available: true }, part: (fraction) => ({ look: { preset: "faded" as LookPreset, strength: fraction } }) },
  { id: "mono", category: "color_look", label: "Mono", availability: { available: true }, part: (fraction) => ({ look: { preset: "mono" as LookPreset, strength: fraction } }) },
  {
    id: "mirror",
    category: "frame_mirror",
    label: "Mirror the footage",
    availability: { available: true },
    part: () => ({ mirror: true }),
  },
  {
    id: "tight_frame",
    category: "frame_mirror",
    label: "Tighter frame",
    availability: { available: true },
    part: (fraction) => ({ framing: { zoom: 1 + 0.06 * fraction, rotationDeg: 0, offsetXPct: 0, offsetYPct: 0 } }),
  },
  { id: "grain_fine", category: "texture_grain", label: "Fine grain", availability: { available: true }, part: (fraction) => ({ grain: { strength: fraction } }) },
  {
    id: "grain_heavy",
    category: "texture_grain",
    label: "Heavy grain",
    availability: { available: true },
    part: (fraction) => ({ grain: { strength: Math.min(1, fraction * 1.5) } }),
  },
  { id: "vignette_soft", category: "lighting", label: "Soft vignette", availability: { available: true }, part: (fraction) => ({ vignette: { strength: fraction } }) },
  {
    id: "vignette_deep",
    category: "lighting",
    label: "Deep vignette",
    availability: { available: true },
    part: (fraction) => ({ vignette: { strength: Math.min(1, fraction * 1.4) } }),
  },
  {
    id: "text_style",
    category: "text_overlay",
    label: "Text style",
    availability: { available: false, reason: TEXT_OVERLAY_REASON },
    part: () => ({}),
  },
];

/** The options of a category, in catalog order. */
export function optionsOf(category: RepurposeCategory): readonly TreatmentOption[] {
  return OPTIONS.filter((option) => option.category === category);
}

/**
 * The capabilities the repurpose screen names but cannot apply in this release. Each carries its reason, so the screen shows it as unavailable
 * and never as a working selector.
 */
export const UNAVAILABLE_CAPABILITIES: ReadonlyArray<{ id: "templates" | "packs"; label: string; reason: string }> = [
  {
    id: "templates",
    label: "Templates",
    reason: "Styled editor templates are not implemented in Meridian yet, so no template can be applied.",
  },
  {
    id: "packs",
    label: "Packs",
    reason: "Meridian has no treatment packs yet. Packs will be Meridian-owned presets, so none is offered now.",
  },
];

/** The intensity scale, 1 (light) to 5 (full). Level 3 is the default, moderate. Each level is a fraction of an option's full strength. */
export const INTENSITY_LEVELS = [1, 2, 3, 4, 5] as const;
export type Intensity = (typeof INTENSITY_LEVELS)[number];
export const DEFAULT_INTENSITY: Intensity = 3;
export const INTENSITY_FRACTION: Record<Intensity, number> = { 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 5: 1 };

/** A repurpose makes at most this many variations, and at least one. The default is a modest three. */
export const MAX_REPURPOSE_VARIANTS = 8;
export const DEFAULT_REPURPOSE_VARIANTS = 3;
