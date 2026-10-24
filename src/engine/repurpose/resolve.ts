// Resolves a repurpose request into its variations (pure). The settings are validated; the feature is off unless it is enabled; each variation
// takes one option from every enabled category; the choices are drawn from a seed that the source, the request and the settings name, so a
// retry makes the same variations; and no two variations share a combination. A variation's visual treatment is checked against the contract.

import { createHash } from "node:crypto";
import { z } from "zod";
import { visualTreatmentSchema, type VisualTreatment } from "../contracts/index.ts";
import {
  CATEGORY_LABELS,
  DEFAULT_INTENSITY,
  DEFAULT_REPURPOSE_VARIANTS,
  INTENSITY_FRACTION,
  MAX_REPURPOSE_VARIANTS,
  optionsOf,
  REPURPOSE_CATEGORIES,
  type Intensity,
  type RepurposeCategory,
  type TreatmentOption,
  type TreatmentPart,
} from "./catalog.ts";

const categorySettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** The options the variation pool may use. Empty means none is chosen, which is refused while the category is on. */
    options: z.array(z.string().min(1)).max(32),
  })
  .strict();

export const repurposeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    intensity: z.number().int().min(1).max(5),
    variantCount: z.number().int().min(1).max(MAX_REPURPOSE_VARIANTS),
    categories: z
      .object({
        warp_rotation: categorySettingsSchema,
        color_look: categorySettingsSchema,
        frame_mirror: categorySettingsSchema,
        texture_grain: categorySettingsSchema,
        lighting: categorySettingsSchema,
        text_overlay: categorySettingsSchema,
      })
      .strict(),
  })
  .strict();
export type RepurposeSettings = z.infer<typeof repurposeSettingsSchema>;

/**
 * The settings a new repurpose starts from: off, moderate intensity, the default count, and every category with an option Meridian can apply
 * switched on with all of its options. A category Meridian cannot apply (text overlays) starts off.
 */
export function defaultRepurposeSettings(): RepurposeSettings {
  const category = (id: RepurposeCategory) => {
    const available = optionsOf(id).filter((option) => option.availability.available);
    return { enabled: available.length > 0, options: available.map((option) => option.id) };
  };
  return {
    enabled: false,
    intensity: DEFAULT_INTENSITY,
    variantCount: DEFAULT_REPURPOSE_VARIANTS,
    categories: {
      warp_rotation: category("warp_rotation"),
      color_look: category("color_look"),
      frame_mirror: category("frame_mirror"),
      texture_grain: category("texture_grain"),
      lighting: category("lighting"),
      text_overlay: category("text_overlay"),
    },
  };
}

export type RepurposedTreatment = { category: RepurposeCategory; optionId: string; label: string };

export type RepurposedVariation = {
  index: number;
  /** A stable key: the same source, request and settings name the same variation. */
  key: string;
  /** The 32-bit seed the variation was named with, recorded so a retry can be checked against it. */
  seed: number;
  treatments: RepurposedTreatment[];
  visual: VisualTreatment;
};

export type RepurposeOutcome =
  | { status: "off" }
  | { status: "refused"; reasons: string[] }
  | { status: "resolved"; variations: RepurposedVariation[]; requested: number; reasons: string[] };

const ROUND = 1000;
const round = (value: number): number => Math.round(value * ROUND) / ROUND;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Joins the parts of one variation into one visual treatment. Framing adds up within its bounds; the look, grain and vignette are one each. */
function mergeParts(parts: TreatmentPart[]): Omit<VisualTreatment, "version"> {
  const merged: Omit<VisualTreatment, "version"> = {};
  let zoom = 1;
  let rotation = 0;
  let offsetX = 0;
  let offsetY = 0;
  let framed = false;
  for (const part of parts) {
    if (part.framing !== undefined) {
      framed = true;
      zoom = Math.max(zoom, part.framing.zoom);
      rotation += part.framing.rotationDeg;
      offsetX += part.framing.offsetXPct;
      offsetY += part.framing.offsetYPct;
    }
    if (part.look !== undefined) merged.look = part.look;
    if (part.mirror === true) merged.mirror = true;
    if (part.grain !== undefined) merged.grain = part.grain;
    if (part.vignette !== undefined) merged.vignette = part.vignette;
  }
  if (framed) {
    merged.framing = {
      zoom: round(zoom),
      rotationDeg: round(clamp(rotation, -2, 2)),
      offsetXPct: round(clamp(offsetX, -3, 3)),
      offsetYPct: round(clamp(offsetY, -3, 3)),
    };
  }
  return merged;
}

/** A 32-bit number from a digest of the given labels: the same labels always give the same number. */
function u32(...labels: string[]): number {
  return createHash("sha256").update(labels.join("|")).digest().readUInt32BE(0);
}

type Pool = { category: RepurposeCategory; options: TreatmentOption[] };

/**
 * Resolves a repurpose. The source is named by its EDL id, the request by its id; the settings are validated here, not trusted. A disabled
 * repurpose is `off`, which makes nothing. A refused one names each reason, and no variation is made from it.
 */
export function resolveRepurpose(input: { settings: unknown; sourceEdlId: string; requestId: string }): RepurposeOutcome {
  const parsed = repurposeSettingsSchema.safeParse(input.settings);
  if (!parsed.success) {
    return { status: "refused", reasons: parsed.error.issues.map((issue) => `${issue.path.join(".") || "settings"}: ${issue.message}`) };
  }
  const settings = parsed.data;
  if (!settings.enabled) return { status: "off" };

  const reasons: string[] = [];
  const pools: Pool[] = [];
  for (const category of REPURPOSE_CATEGORIES) {
    const chosen = settings.categories[category];
    if (!chosen.enabled) continue;
    const label = CATEGORY_LABELS[category];
    const known = optionsOf(category);
    const applicable = known.filter((option) => option.availability.available);
    if (applicable.length === 0) {
      const why = known.map((option) => (option.availability.available ? "" : option.availability.reason)).filter((text) => text !== "");
      reasons.push(`${label} is switched on, but no option in it can be applied: ${why.join(" ")}`);
      continue;
    }
    if (new Set(chosen.options).size !== chosen.options.length) reasons.push(`${label} names an option twice.`);
    const unknown = chosen.options.filter((id) => !applicable.some((option) => option.id === id));
    if (unknown.length > 0) reasons.push(`${label} names an option that is not in it or cannot be applied: ${unknown.join(", ")}.`);
    const narrowed = applicable.filter((option) => chosen.options.includes(option.id));
    if (narrowed.length === 0) reasons.push(`${label} is switched on with no option chosen. Choose one, or switch the category off.`);
    else pools.push({ category, options: narrowed });
  }
  if (reasons.length > 0) return { status: "refused", reasons };
  if (pools.length === 0) return { status: "refused", reasons: ["Switch on at least one treatment category to make repurposed variations."] };

  const space = pools.reduce((count, pool) => count * pool.options.length, 1);
  const requested = settings.variantCount;
  const target = Math.min(requested, space);
  const outcomeReasons: string[] = [];
  if (target < requested) {
    outcomeReasons.push(
      `Only ${space} distinct combination${space === 1 ? "" : "s"} can be made from the chosen options, so ${target} variation${target === 1 ? "" : "s"} will be made.`,
    );
  }

  const fraction = INTENSITY_FRACTION[settings.intensity as Intensity];
  const canonical = JSON.stringify({ intensity: settings.intensity, pools: pools.map((pool) => [pool.category, pool.options.map((option) => option.id)]) });
  const variations: RepurposedVariation[] = [];
  const seen = new Set<string>();
  const attempts = target * 64 + 64;
  for (let attempt = 0; variations.length < target && attempt < attempts; attempt += 1) {
    const picks = pools.map((pool) => {
      const at = u32(input.sourceEdlId, input.requestId, canonical, pool.category, String(attempt)) % pool.options.length;
      return { category: pool.category, option: pool.options[at] as TreatmentOption };
    });
    const combination = picks.map((pick) => pick.option.id).join("|");
    if (seen.has(combination)) continue;
    seen.add(combination);
    const parts = picks.map((pick) => pick.option.part(fraction));
    const visual = visualTreatmentSchema.parse({ version: 1, ...mergeParts(parts) });
    variations.push({
      index: variations.length,
      key: createHash("sha256").update(`${input.sourceEdlId}|${canonical}|${combination}`).digest("hex").slice(0, 16),
      seed: u32(input.sourceEdlId, input.requestId, canonical, combination),
      treatments: picks.map((pick) => ({ category: pick.category, optionId: pick.option.id, label: pick.option.label })),
      visual,
    });
  }
  if (variations.length < target) {
    return { status: "refused", reasons: [`Only ${variations.length} distinct variation${variations.length === 1 ? "" : "s"} could be drawn from the options.`] };
  }
  return { status: "resolved", variations, requested, reasons: outcomeReasons };
}
