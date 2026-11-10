// Decision 5 (owner, 2026-11-01): the cookbook decides a run's style, and a Batch's style choice is a filter on cookbooks. This module holds the
// rule and nothing else: which family each brief style belongs to, which style each cookbook has, and what a filter returns. Pure: the browser
// and the server read it, and it imports only the brief-style list and the family list.
//
// A brief style is the Batch's word for a video style (the eight in content-factory/style-presets.ts). A cookbook is a recipe in a family. A
// cookbook's style is its explicit entry in COOKBOOK_STYLE, else the one style of its family, else none. So a blank cookbook, or a family with two
// styles and no explicit entry, has no style and is never offered by a style filter. A style with no cookbook is a gap, and the Batch refuses it
// with that reason instead of falling back to another style.

import { STYLE_PRESETS } from "../content-factory/style-presets.ts";
import { COOKBOOK_FAMILIES } from "./families.ts";

export type CookbookFamily = (typeof COOKBOOK_FAMILIES)[number];

/** The eight brief styles. The order is the library's order. */
export const BRIEF_STYLE_IDS = [
  "product_promo",
  "explainer",
  "talking_head",
  "ugc_style",
  "fast_cut_short",
  "cinematic_story",
  "motion_graphics",
  "tips_list",
] as const;

export type BriefStyleId = (typeof BRIEF_STYLE_IDS)[number];

/**
 * Each brief style's cookbook family: the recommended table, which the owner asked to be built as recommended (2026-11-01). Three entries are
 * guesses for the owner to confirm: fast_cut_short, talking_head and motion_graphics. Changing an entry changes which cookbooks a style filter offers.
 */
export const STYLE_FAMILY: Readonly<Record<BriefStyleId, CookbookFamily>> = {
  product_promo: "product",
  explainer: "explainer",
  talking_head: "other", // guess
  ugc_style: "ugc",
  fast_cut_short: "listicle", // guess
  cinematic_story: "story",
  motion_graphics: "other", // guess
  tips_list: "listicle",
};

/**
 * The style of each built-in cookbook that has one, where its family alone does not say (a listicle family has two styles). The blank
 * starting points have none, so they are not in this table, and their family ("other") is shared by two styles, which gives them no style.
 */
export const COOKBOOK_STYLE: Readonly<Record<string, BriefStyleId>> = {
  ck_3d_data_explainer: "explainer",
  ck_factory_strict_quality: "explainer",
  ck_ugc_product: "ugc_style",
  ck_factory_viral_ugc: "ugc_style",
  ck_factory_problem_solution: "product_promo",
  ck_voice_listicle: "tips_list",
  ck_factory_manual_cloud: "talking_head",
  // The code-drawn styles (owner request 2026-11-09).
  ck_isometric_explainer: "explainer",
  ck_line_diagram: "explainer",
  ck_pixel_explainer: "explainer",
  ck_paper_cut_story: "cinematic_story",
  ck_stacked_data_chart: "motion_graphics",
};

export type StyleCookbook = { cookbookId: string; family: CookbookFamily };

/** The label a person reads for a brief style. Falls back to the id when the library does not have it (it always does). */
export function styleLabel(style: BriefStyleId): string {
  return STYLE_PRESETS.find((preset) => preset.id === style)?.label ?? style;
}

/**
 * A cookbook's style: its explicit entry, else the single style its family maps to, else null. A family shared by two or more styles gives
 * no style without an explicit entry, so an ambiguous cookbook is never filed under a style by accident.
 */
export function styleOfCookbook(cookbook: StyleCookbook): BriefStyleId | null {
  const explicit = COOKBOOK_STYLE[cookbook.cookbookId];
  if (explicit !== undefined) return explicit;
  const sharing = BRIEF_STYLE_IDS.filter((style) => STYLE_FAMILY[style] === cookbook.family);
  return sharing.length === 1 ? (sharing[0] ?? null) : null;
}

/** The cookbooks a style filter offers, in the order given. A cookbook with no style is never offered. */
export function cookbooksForStyle<T extends StyleCookbook>(style: BriefStyleId, cookbooks: readonly T[]): T[] {
  return cookbooks.filter((cookbook) => styleOfCookbook(cookbook) === style);
}

/** The brief styles that at least one cookbook carries, in the library's order. */
export function coveredStyles(cookbooks: readonly StyleCookbook[]): BriefStyleId[] {
  const carried = new Set(cookbooks.map((cookbook) => styleOfCookbook(cookbook)).filter((style): style is BriefStyleId => style !== null));
  return BRIEF_STYLE_IDS.filter((style) => carried.has(style));
}

/** The brief styles no cookbook carries. A Batch that asks for one is refused, with the words that say so. */
export function styleGaps(cookbooks: readonly StyleCookbook[]): BriefStyleId[] {
  const covered = new Set(coveredStyles(cookbooks));
  return BRIEF_STYLE_IDS.filter((style) => !covered.has(style));
}

/** Whether a value is one of the eight brief styles. */
export function isBriefStyleId(value: string): value is BriefStyleId {
  return (BRIEF_STYLE_IDS as readonly string[]).includes(value);
}
