// Step 4 of the plan (Bible 6.4): build each shot's source from its chosen type. Pure. A generated shot takes the prompt the
// planner wrote, a stock shot takes its query, and a component shot takes props drawn from the shot's own words and the product
// kit (text and prices are drawn by code, L8). Every component's props are checked against the library's own schema, so a shot
// the library cannot draw is refused here, not at render time.

import { COMPONENT_LIBRARY } from "../compose/components/index.ts";
import type { ComponentDefinition } from "../compose/library.ts";
import type { BeatRole, ModelClass, Persona, ProductKit, ShotLayer, ShotSource, VisualType } from "../contracts/index.ts";
import { heroUriOf } from "./product.ts";
import { KINETIC_WORDS_PER_LINE } from "./tables.ts";

/** The component names of the E3 library that the plan draws with (Bible 9.2). */
export const COMPONENT_FOR = {
  kinetic: "kinetic.punchline",
  title: "title.hook",
  cta: "cta.card",
  product: "product.card",
} as const;

/** How many approved claims a product card lists (product.card's own bullet limit). */
const CARD_BULLETS = 3;

/** The shot facts a source needs. The words are the script's words that the shot speaks (voice word timings, 6.3). */
export type SourceShot = {
  shotId: string;
  durationMs: number;
  beatRole: BeatRole;
  showsProduct: boolean;
  words: readonly string[];
  /** The beat's emphasis words that the shot speaks, in script order. */
  emphasis: readonly string[];
};

export type BuildSourceInput = {
  visualType: VisualType;
  shot: SourceShot;
  /** The planner's generation prompt for this shot, when it wrote one. */
  prompt?: string;
  /** The planner's stock search query for this shot, when it wrote one. */
  query?: string;
  persona?: Persona;
  productKit?: ProductKit;
  /** The approved claims the request names for the product (ProductionRequest.product.claimIds). */
  claimIds: readonly string[];
};

export type BuiltSource = { layer: ShotLayer; source: ShotSource };
export type SourceResult = { ok: true; built: BuiltSource } | { ok: false; reason: string };

export type PropsCheck = { ok: true } | { ok: false; reason: string };

/** The lines of a kinetic.punchline shot: its words, KINETIC_WORDS_PER_LINE to a line, in script order. */
export function kineticLinesOf(words: readonly string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < words.length; index += KINETIC_WORDS_PER_LINE) {
    lines.push(words.slice(index, index + KINETIC_WORDS_PER_LINE).join(" "));
  }
  return lines;
}

/** The emphasis words the shot speaks, so a title or a card highlights only words that are on screen. */
export function emphasisIn(words: readonly string[], emphasis: readonly string[]): string[] {
  const spoken = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")));
  return emphasis.filter((item) => spoken.has(item.toLowerCase().replace(/[^a-z0-9]/g, "")));
}

/** Checks props against a library component's own schema, with the reserved durationMs the compiler will set. Unknown is a refusal. */
export function checkComponentProps(component: string, props: Record<string, unknown>, durationMs: number): PropsCheck {
  const definition: ComponentDefinition | undefined = COMPONENT_LIBRARY[component];
  if (definition === undefined) {
    return { ok: false, reason: `component ${component} is not in the library` };
  }
  const parsed = definition.propsSchema.safeParse({ ...props, durationMs });
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "props");
    return { ok: false, reason: `${component} props do not fit its schema at ${paths.join(", ")}` };
  }
  return { ok: true };
}

/**
 * The component types a shot cannot be drawn as, with the reason, from the shot's own words (rule 6, the text a component can
 * hold). A product shot draws the product card from the kit, so its words are not checked here. Used by align.ts.
 */
export function componentRefusals(shot: Omit<SourceShot, "shotId">): Partial<Record<VisualType, string>> {
  const refusals: Partial<Record<VisualType, string>> = {};
  const kinetic = checkComponentProps(COMPONENT_FOR.kinetic, { lines: kineticLinesOf(shot.words) }, shot.durationMs);
  if (!kinetic.ok) {
    refusals.kinetic_type = kinetic.reason;
  }
  if (!shot.showsProduct) {
    const text = shot.words.join(" ");
    const emphasis = emphasisIn(shot.words, shot.emphasis);
    const coded =
      shot.beatRole === "cta"
        ? checkComponentProps(COMPONENT_FOR.cta, { text, arrow: "down" }, shot.durationMs)
        : checkComponentProps(COMPONENT_FOR.title, { text, ...(emphasis.length > 0 ? { emphasis } : {}) }, shot.durationMs);
    if (!coded.ok) {
      refusals.coded_graphics = coded.reason;
    }
  }
  return refusals;
}

function refuse(reason: string): SourceResult {
  return { ok: false, reason };
}

/** The approved claim texts of the named claims, in the order the request gives them. Unknown claim ids are skipped. */
function claimTextsOf(kit: ProductKit, claimIds: readonly string[]): string[] {
  return claimIds.flatMap((claimId) => {
    const claim = kit.approvedClaims.find((item) => item.claimId === claimId);
    return claim === undefined ? [] : [claim.text];
  });
}

function generated(modelClass: ModelClass, prompt: string, refs: string[], takes: 1 | 2, firstFrame?: string): ShotSource {
  return {
    kind: "generate",
    modelClass,
    prompt,
    refs,
    takes,
    ...(firstFrame === undefined ? {} : { firstFrame }),
  };
}

/** A component source for a checked props object. The props stored carry no durationMs: the compiler sets it. */
function component(name: string, props: Record<string, unknown>, durationMs: number, layer: ShotLayer): SourceResult {
  const check = checkComponentProps(name, props, durationMs);
  if (!check.ok) return refuse(check.reason);
  return { ok: true, built: { layer, source: { kind: "component", component: name, props } } };
}

/**
 * The source of one shot for its chosen type (6.4 step 4). A type the shot's inputs cannot feed is refused with the reason, so
 * the plan gate can name the shot. Every generated type needs its prompt; stock needs its query.
 */
export function buildSource(input: BuildSourceInput): SourceResult {
  const { shot, visualType } = input;
  const text = shot.words.join(" ");
  const hero = input.productKit === undefined ? null : heroUriOf(input.productKit);

  switch (visualType) {
    case "ugc_presenter": {
      const portrait = input.persona?.portraits[0];
      if (input.persona === undefined || portrait === undefined) return refuse("the presenter needs the page's persona and a portrait");
      if (input.prompt === undefined) return refuse("no prompt was written for this presenter shot");
      return { ok: true, built: { layer: "presenter", source: generated("avatar", input.prompt, [portrait], 1) } };
    }
    case "product_hero": {
      if (hero === null) return refuse("the product kit has no image to pin as the hero frame");
      if (input.prompt === undefined) return refuse("no prompt was written for this product shot");
      return { ok: true, built: { layer: "base", source: generated("video.budget", input.prompt, [hero], 1, hero) } };
    }
    case "cinematic": {
      if (input.prompt === undefined) return refuse("no prompt was written for this cinematic shot");
      if (shot.showsProduct) {
        if (hero === null) return refuse("a cinematic product shot needs a pinned hero image (7.2 rule 2)");
        return { ok: true, built: { layer: "base", source: generated("video.cinematic", input.prompt, [hero], 2, hero) } };
      }
      return { ok: true, built: { layer: "base", source: generated("video.cinematic", input.prompt, [], 2) } };
    }
    case "stock_footage": {
      if (input.query === undefined) return refuse("no search query was written for this stock shot");
      return { ok: true, built: { layer: "base", source: { kind: "stock", query: input.query, minMs: shot.durationMs } } };
    }
    case "kinetic_type":
      return component(COMPONENT_FOR.kinetic, { lines: kineticLinesOf(shot.words) }, shot.durationMs, "graphics");
    case "coded_graphics": {
      if (shot.showsProduct) {
        if (input.productKit === undefined || hero === null) return refuse("the product card needs the product kit and its hero image");
        const bullets = claimTextsOf(input.productKit, input.claimIds).slice(0, CARD_BULLETS);
        return component(COMPONENT_FOR.product, { name: input.productKit.name, bullets, heroUri: hero }, shot.durationMs, "graphics");
      }
      if (shot.beatRole === "cta") {
        const keyword = emphasisIn(shot.words, shot.emphasis)[0];
        return component(COMPONENT_FOR.cta, { text, arrow: "down", ...(keyword === undefined ? {} : { keyword }) }, shot.durationMs, "graphics");
      }
      const emphasis = emphasisIn(shot.words, shot.emphasis);
      return component(COMPONENT_FOR.title, { text, ...(emphasis.length > 0 ? { emphasis } : {}) }, shot.durationMs, "graphics");
    }
    default:
      return refuse(`${visualType} has no source in the E3 plan`);
  }
}
