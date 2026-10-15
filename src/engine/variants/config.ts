// Variant settings (Video Engine Bible 6.13 and 14.3). The per-change cost estimates are not here: they are read from
// config/budgets.ts (budgets.variantCostUsd). What lives here is what the variants code needs and no config file holds yet:
// the attribute names, the caption positions the compositor draws, and the music mix a variant uses when the master has no
// music to copy. The mix mirrors edit/tuning.ts (EDIT_TUNING.music); variants/expand.test.ts checks the two agree, so a change
// to the editor's mix is seen here before it ships. Nothing else is a number in this folder.

/** The six attributes a variant can change (Bible 6.13). Each variant changes exactly one of them against the master. */
export const VARIANT_ATTRIBUTES = ["caption", "music", "hook", "product", "persona", "language"] as const;
export type VariantAttribute = (typeof VARIANT_ATTRIBUTES)[number];

/**
 * The attributes in the order a variant fits the budget and the matrix. A tie on cost goes to the earlier attribute, so the fit
 * is the same every run. The order is the matrix's own order (Bible 4, VariantMatrix).
 */
export const ATTRIBUTE_ORDER: Readonly<Record<VariantAttribute, number>> = Object.freeze({
  caption: 0,
  music: 1,
  hook: 2,
  product: 3,
  persona: 4,
  language: 5,
});

/** The caption positions the compositor draws (compose/components/captions.karaoke, the band prop). */
export const CAPTION_BANDS = ["upper", "middle", "lower"] as const;
export type CaptionBand = (typeof CAPTION_BANDS)[number];

/** The caption component the compositor draws (compose/library). A caption style naming another component is not drawable. */
export const DRAWABLE_CAPTION_COMPONENT = "captions.karaoke" as const;

/** The music mix a variant uses when the master has no music to copy (mirrors edit/tuning.ts EDIT_TUNING.music, in dB). */
export const variantMusicMix = {
  gainDb: -12,
  duckDb: -18,
} as const;

/** The stable prefix of a variant EDL id. The rest is a hash of the master EDL and the variant key (Bible 5.1: a retry names the same EDL). */
export const VARIANT_EDL_PREFIX = "edl_" as const;
