// Plan tables for the visual decision engine (Bible sections 7.1, 7.3, 7.4 and 7.5). These are data, not logic.
//
// They are versioned like config, but they live here because src/engine/config/ belongs to W1 (eng-contracts). Numbers
// that come from the Bible are cited. Numbers marked INITIAL are the author's judgement from the 7.1 "best for" column,
// not measurements; the learning loop (16.2) and the owner replace them. The lead decides whether these tables move
// into src/engine/config/ (see plan/STATUS.md).

import { z } from "zod";
import { VISUAL_TYPES, type BeatRole, type ModelClass, type ReferenceShotType, type VisualType } from "../contracts/index.ts";

export const PLAN_TABLES_VERSION = "planTables@1";

// --- 7.3: the properties a request's text is classified into (Claude, Haiku, in E3) ----------------------------------

export const VISUAL_PROPERTIES = [
  "real_product",
  "person_talking",
  "motion_spectacle",
  "cartoon_style",
  "data_or_list",
  "text_led",
  "real_world_context",
  "stop_motion_style",
  "screen_or_chat",
] as const;

export type VisualProperty = (typeof VISUAL_PROPERTIES)[number];
export const visualPropertySchema = z.enum(VISUAL_PROPERTIES);

/** Which types can deliver each property (7.3). INITIAL mapping, written from the 7.1 "best for" and "recipe" columns. */
export const PROPERTY_TYPES: Record<VisualProperty, readonly VisualType[]> = {
  real_product: ["product_hero", "coded_graphics", "stop_motion", "cinematic"],
  person_talking: ["ugc_presenter", "react_clip"],
  motion_spectacle: ["cinematic", "product_hero", "cartoon_generated"],
  cartoon_style: ["cartoon_rigged", "cartoon_generated"],
  data_or_list: ["coded_graphics"],
  text_led: ["kinetic_type", "coded_graphics"],
  real_world_context: ["stock_footage", "cinematic"],
  stop_motion_style: ["stop_motion"],
  screen_or_chat: ["screen_mock"],
};

// --- 7.4: reference shot type to proposed types, in order -------------------------------------------------------------

export const PROPOSALS: Record<ReferenceShotType, readonly VisualType[]> = {
  talking_head: ["ugc_presenter", "react_clip"],
  broll_montage: ["stock_footage", "product_hero", "cinematic"],
  product_closeup: ["product_hero", "stop_motion"],
  onscreen_list: ["coded_graphics"],
  sketch_joke: ["cartoon_rigged", "cartoon_generated"],
  spectacle: ["cinematic", "product_hero"],
  screen_record: ["screen_mock"],
  react: ["react_clip", "ugc_presenter"],
  text_only: ["kinetic_type"],
  other: ["stock_footage", "kinetic_type"],
};

// --- 7.1 and 7.6: how each type is made, which decides its cost ------------------------------------------------------

/** A generated type is billed per second of shot (times takes), or per frame for stop-motion. */
export type GenerateRecipe =
  | { kind: "generate"; modelClass: ModelClass; takes: 1 | 2; billing: "second" }
  | { kind: "generate"; modelClass: ModelClass; takes: 1 | 2; billing: "frame"; framesPerSecond: number };

/** Stock and components cost what their price key says (pexels, code_component). */
export type Recipe = GenerateRecipe | { kind: "stock" } | { kind: "component" };

/**
 * One recipe per visual type (7.1). cinematic uses 2 takes (7.1 "2 takes"). stop_motion bills 12 frames per second, the
 * top of the 8 to 12 fps range in 7.1, so the planner never under-costs it. cartoon_generated bills its video model
 * only: the keyframe image is not priced in the budget contract yet (see plan/STATUS.md).
 */
export const RECIPES: Record<VisualType, Recipe> = {
  ugc_presenter: { kind: "generate", modelClass: "avatar", takes: 1, billing: "second" },
  product_hero: { kind: "generate", modelClass: "video.budget", takes: 1, billing: "second" },
  cinematic: { kind: "generate", modelClass: "video.cinematic", takes: 2, billing: "second" },
  cartoon_generated: { kind: "generate", modelClass: "video.budget", takes: 1, billing: "second" },
  react_clip: { kind: "generate", modelClass: "avatar", takes: 1, billing: "second" },
  stop_motion: { kind: "generate", modelClass: "image.edit", takes: 1, billing: "frame", framesPerSecond: 12 },
  stock_footage: { kind: "stock" },
  cartoon_rigged: { kind: "component" },
  coded_graphics: { kind: "component" },
  kinetic_type: { kind: "component" },
  screen_mock: { kind: "component" },
};

export function isGeneratedType(visualType: VisualType): boolean {
  return RECIPES[visualType].kind === "generate";
}

// --- 7.1 "Downgrade to": the fallback chain (an empty list means none is needed) ------------------------------------

export const DOWNGRADE_TO: Record<VisualType, readonly VisualType[]> = {
  ugc_presenter: ["kinetic_type"],
  product_hero: ["coded_graphics"],
  stock_footage: [],
  cinematic: ["product_hero", "stock_footage"],
  cartoon_rigged: ["kinetic_type"],
  cartoon_generated: ["cartoon_rigged"],
  coded_graphics: [],
  react_clip: ["ugc_presenter"],
  kinetic_type: [],
  stop_motion: ["product_hero"],
  screen_mock: [],
};

// --- 7.5 beatFit(beatRole, t): how well a type serves each beat role. INITIAL values, 0 to 1. -----------------------------

export const BEAT_FIT: Record<BeatRole, Record<VisualType, number>> = {
  hook: {
    ugc_presenter: 1.0, product_hero: 0.5, stock_footage: 0.4, cinematic: 0.8, cartoon_rigged: 0.6,
    cartoon_generated: 0.6, coded_graphics: 0.5, react_clip: 0.7, kinetic_type: 0.9, stop_motion: 0.5, screen_mock: 0.4,
  },
  setup: {
    ugc_presenter: 0.8, product_hero: 0.4, stock_footage: 0.9, cinematic: 0.6, cartoon_rigged: 0.5,
    cartoon_generated: 0.5, coded_graphics: 0.3, react_clip: 0.5, kinetic_type: 0.5, stop_motion: 0.4, screen_mock: 0.4,
  },
  item: {
    ugc_presenter: 0.6, product_hero: 1.0, stock_footage: 0.5, cinematic: 0.5, cartoon_rigged: 0.3,
    cartoon_generated: 0.4, coded_graphics: 0.9, react_clip: 0.4, kinetic_type: 0.4, stop_motion: 0.7, screen_mock: 0.6,
  },
  proof: {
    ugc_presenter: 0.7, product_hero: 1.0, stock_footage: 0.5, cinematic: 0.4, cartoon_rigged: 0.2,
    cartoon_generated: 0.3, coded_graphics: 0.9, react_clip: 0.4, kinetic_type: 0.5, stop_motion: 0.5, screen_mock: 0.7,
  },
  twist: {
    ugc_presenter: 0.6, product_hero: 0.4, stock_footage: 0.4, cinematic: 0.7, cartoon_rigged: 0.9,
    cartoon_generated: 0.8, coded_graphics: 0.3, react_clip: 0.9, kinetic_type: 0.8, stop_motion: 0.5, screen_mock: 0.5,
  },
  payoff: {
    ugc_presenter: 0.7, product_hero: 0.8, stock_footage: 0.5, cinematic: 0.7, cartoon_rigged: 0.5,
    cartoon_generated: 0.5, coded_graphics: 0.7, react_clip: 0.5, kinetic_type: 0.8, stop_motion: 0.5, screen_mock: 0.5,
  },
  cta: {
    ugc_presenter: 0.6, product_hero: 0.6, stock_footage: 0.3, cinematic: 0.3, cartoon_rigged: 0.3,
    cartoon_generated: 0.3, coded_graphics: 0.9, react_clip: 0.3, kinetic_type: 0.9, stop_motion: 0.4, screen_mock: 0.6,
  },
};

// --- 7.5 styleFit: the style kit's preferred and banned lists (13). INITIAL values. ----------------------------------------

export const STYLE_FIT = { preferred: 1, neutral: 0.5, banned: 0 } as const;

// --- 7.5 continuity and repetition: families of types that read as one run ----------------------------------------------

export const VISUAL_FAMILIES = ["presenter", "generated_video", "stop_motion", "cartoon", "graphics", "footage"] as const;
export type VisualFamily = (typeof VISUAL_FAMILIES)[number];

export const FAMILY_OF: Record<VisualType, VisualFamily> = {
  ugc_presenter: "presenter",
  react_clip: "presenter",
  product_hero: "generated_video",
  cinematic: "generated_video",
  stop_motion: "stop_motion",
  cartoon_rigged: "cartoon",
  cartoon_generated: "cartoon",
  coded_graphics: "graphics",
  kinetic_type: "graphics",
  screen_mock: "graphics",
  stock_footage: "footage",
};

// --- 7.5 artifactRisk prior: the catalogue gives no failure rates, so the prior is by how the type is made --------------

/** Prior take failure rate used until a type has enough takes (see score.ts). INITIAL, not measured. */
export const ARTIFACT_RISK_PRIOR = { generate: 0.3, stock: 0.05, component: 0 } as const;

// --- 13 and 7.2 rule 6: the kit each type needs ------------------------------------------------------------------------

export const KIT_NEEDS = ["persona", "rigCharacter", "generatedCharacter", "productKit"] as const;
export type KitNeed = (typeof KIT_NEEDS)[number];

export const KIT_REQUIREMENTS: Record<VisualType, readonly KitNeed[]> = {
  ugc_presenter: ["persona"],
  react_clip: ["persona"],
  product_hero: ["productKit"],
  cinematic: [],
  cartoon_rigged: ["rigCharacter"],
  cartoon_generated: ["generatedCharacter"],
  stop_motion: ["productKit"],
  stock_footage: [],
  coded_graphics: [],
  kinetic_type: [],
  screen_mock: [],
};

// --- 7.2 rule 2: types that would generate the product without a pinned hero image --------------------------------------

/** cartoon_generated always does this; cinematic does it unless its first frame is pinned to the hero image. */
export const PRODUCT_PIXEL_RISK: Partial<Record<VisualType, "always" | "unless_pinned">> = {
  cartoon_generated: "always",
  cinematic: "unless_pinned",
};

// --- E3 build gaps (7.1, 7.2 rule 6): types whose source cannot be built yet. A gap is a missing source, not a missing kit.
// Rule 6 (kitRejection) removes the type from every shot and from the minimum, with the reason written into the rejection.
// The list shrinks as E5 lands; a type is added only with a note in plan/STATUS.md.

export const BUILD_GAPS: Partial<Record<VisualType, string>> = {
  cartoon_rigged: "the rig component is not in the E3 component library (E5)",
  react_clip: "it needs an owned or licensed clip, and no clip source exists yet",
  screen_mock: "the chat component is not in the E3 component library (E2 and E5)",
  cartoon_generated: "its style keyframe is a second paid call that one shot source cannot carry (plan/STATUS.md)",
};

/** The visual types the E3 planner can build a source for: every type that has no build gap. */
export const BUILDABLE_TYPES: readonly VisualType[] = VISUAL_TYPES.filter((visualType) => BUILD_GAPS[visualType] === undefined);

/** Words per line of a kinetic.punchline shot: the shot's words are grouped in order (7.1 kinetic_type). Structural. */
export const KINETIC_WORDS_PER_LINE = 4;
