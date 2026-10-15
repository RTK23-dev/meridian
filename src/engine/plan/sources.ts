// Step 4 of the plan (Bible 6.4): build each shot's source from its chosen type. Pure. A generated shot takes the prompt the
// planner wrote, with the code's style for its type in front (tables.ts PROMPT_STYLE). A stock shot takes its query. A component
// shot takes props drawn from the shot's own words, the product kit and the character sheet (text, prices and logos are drawn by
// code, L8). Every component's props are checked against the library's own schema, so a shot the library cannot draw is refused
// here, not at render time. cartoon_generated and stop_motion are chains of calls (tables.ts GENERATION_CHAINS): a ShotSource
// carries one call, so their builders refuse and name the chain; the chain builders below return the calls for the produce step.

import { COMPONENT_LIBRARY } from "../compose/components/index.ts";
import type { MouthEvent, RigPose, RigViseme } from "../compose/components/character.rig/props.ts";
import { MAX_APP_ROWS, MAX_CHAT_MESSAGES } from "../compose/components/screen.mock/props.ts";
import type { ComponentDefinition } from "../compose/library.ts";
import type { BeatRole, CharacterSheet, ModelClass, Persona, ProductKit, ShotLayer, ShotSource, VisualType } from "../contracts/index.ts";
import { rigSheetProblem } from "./character.ts";
import { heroUriOf } from "./product.ts";
import {
  KINETIC_WORDS_PER_LINE,
  PROMPT_STYLE,
  RIG_ID,
  RIG_PLAY,
  STOP_MOTION_FPS,
  STOP_MOTION_FRAMES,
  type StyledVisualType,
} from "./tables.ts";

/** The component names of the library that the plan draws with (Bible 9.2). */
export const COMPONENT_FOR = {
  kinetic: "kinetic.punchline",
  kineticType: "kinetic.type",
  title: "title.hook",
  cta: "cta.card",
  product: "product.card",
  rig: "character.rig",
  screen: "screen.mock",
} as const;

/** How many approved claims a product card lists (product.card's own bullet limit). */
const CARD_BULLETS = 3;

/** A word's time inside the shot, in ms from the shot's start. */
export type WordSpan = { startMs: number; endMs: number };

/** The shot facts a source needs. The words are the script's words that the shot speaks (voice word timings, 6.3). */
export type SourceShot = {
  shotId: string;
  durationMs: number;
  beatRole: BeatRole;
  showsProduct: boolean;
  words: readonly string[];
  /** The beat's emphasis words that the shot speaks, in script order. */
  emphasis: readonly string[];
  /**
   * Each word's time inside the shot, aligned with `words`. Optional. Without it the words share the shot's length evenly, which
   * is an approximation for animation timing only (the voice track is the clock, 6.3). build.ts passes the voice's spans, timed
   * from the shot's start and clamped to it (align.ts timedWordsOfShot).
   */
  spans?: readonly WordSpan[];
};

export type BuildSourceInput = {
  visualType: VisualType;
  shot: SourceShot;
  /** The planner's generation prompt for this shot, when it wrote one. The code's style for the type goes in front of it. */
  prompt?: string;
  /** The planner's stock search query for this shot, when it wrote one. */
  query?: string;
  persona?: Persona;
  productKit?: ProductKit;
  /** The page's character sheet for this shot (rigged for cartoon_rigged, generated for cartoon_generated). */
  character?: CharacterSheet;
  /** The approved claims the request names for the product (ProductionRequest.product.claimIds). */
  claimIds: readonly string[];
};

export type BuiltSource = { layer: ShotLayer; source: ShotSource };
export type SourceResult = { ok: true; built: BuiltSource } | { ok: false; reason: string };

export type PropsCheck = { ok: true } | { ok: false; reason: string };

/** A value or the reason it cannot be built. Used by the chain builders and the timing helpers. */
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The lines of a kinetic.punchline shot: its words, KINETIC_WORDS_PER_LINE to a line, in script order. */
export function kineticLinesOf(words: readonly string[]): string[] {
  return kineticWordGroups(words).map((group) => group.join(" "));
}

function kineticWordGroups(words: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (let index = 0; index < words.length; index += KINETIC_WORDS_PER_LINE) {
    groups.push(words.slice(index, index + KINETIC_WORDS_PER_LINE));
  }
  return groups;
}

/** The emphasis words the shot speaks, so a title or a card highlights only words that are on screen. */
export function emphasisIn(words: readonly string[], emphasis: readonly string[]): string[] {
  const spoken = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")));
  return emphasis.filter((item) => spoken.has(item.toLowerCase().replace(/[^a-z0-9]/g, "")));
}

const TIMINGS_REFUSAL = "the word timings do not match the shot's words";

/** True when the shot has no word timings, or one for each word. A mismatch is refused, never read past the end. */
function timingsFit(shot: Pick<SourceShot, "words" | "spans">): boolean {
  return shot.spans === undefined || shot.spans.length === shot.words.length;
}

/** The span of one word inside the shot (see SourceShot.spans). Words must not be empty when this is called. */
export function wordSpanOf(shot: Pick<SourceShot, "durationMs" | "words" | "spans">, index: number): WordSpan {
  const last = shot.durationMs - 1;
  if (shot.spans !== undefined) {
    const span = shot.spans[index];
    return { startMs: Math.min(span.startMs, last), endMs: Math.min(span.endMs, last) };
  }
  const step = shot.durationMs / shot.words.length;
  const startMs = Math.min(Math.round(index * step), last);
  const endMs = Math.min(Math.round(startMs + step * 0.7), last);
  return { startMs, endMs };
}

/** Kinetic lines with the time each one starts (ms from the shot's start), for kinetic.type. */
export function timedLinesOf(shot: Pick<SourceShot, "durationMs" | "words" | "spans">): Array<{ text: string; atMs: number }> {
  const lines: Array<{ text: string; atMs: number }> = [];
  for (let index = 0; index < shot.words.length; index += KINETIC_WORDS_PER_LINE) {
    const group = shot.words.slice(index, index + KINETIC_WORDS_PER_LINE);
    lines.push({ text: group.join(" "), atMs: wordSpanOf(shot, index).startMs });
  }
  return lines;
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
  const spoken = emphasisIn(shot.words, shot.emphasis);
  if (!timingsFit(shot)) {
    refusals.kinetic_type = TIMINGS_REFUSAL;
  } else if (spoken.length > 0 && refusals.kinetic_type === undefined) {
    // A shot with emphasis words is drawn by kinetic.type, so its own limits (lines, words, emphasis) apply.
    const typed = checkComponentProps(COMPONENT_FOR.kineticType, { lines: timedLinesOf(shot), emphasis: spoken }, shot.durationMs);
    if (!typed.ok) {
      refusals.kinetic_type = typed.reason;
    }
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

/** The code's look for a generated type, in front of the planner's scene. The look names no text, price, logo or person. */
function styledPrompt(visualType: StyledVisualType, prompt: string): string {
  return `${PROMPT_STYLE[visualType]} ${prompt}`;
}

/** A component source for a checked props object. The props stored carry no durationMs: the compiler sets it. */
function component(name: string, props: Record<string, unknown>, durationMs: number, layer: ShotLayer): SourceResult {
  const check = checkComponentProps(name, props, durationMs);
  if (!check.ok) return refuse(check.reason);
  return { ok: true, built: { layer, source: { kind: "component", component: name, props } } };
}

/** A shot's sentences: each is its words, and the index of its first word in the shot. A sentence ends at . ! or ?. */
type Sentence = { words: string[]; start: number };

export function sentencesOf(words: readonly string[]): Sentence[] {
  const sentences: Sentence[] = [];
  let current: string[] = [];
  let start = 0;
  words.forEach((word, index) => {
    if (current.length === 0) {
      start = index;
    }
    current.push(word);
    if (/[.!?]["')\]]*$/.test(word)) {
      sentences.push({ words: current, start });
      current = [];
    }
  });
  if (current.length > 0) {
    sentences.push({ words: current, start });
  }
  return sentences;
}

/** The mouth shape a spoken word makes, by its first vowel: round for o and u, wide for e, i and y, open for the rest. */
export function mouthShapeFor(word: string): RigViseme {
  const letters = word.toLowerCase().replace(/[^a-z]/g, "");
  const vowel = letters.match(/[aeiouy]/)?.[0];
  if (vowel === "o" || vowel === "u") return "round";
  if (vowel === "e" || vowel === "i" || vowel === "y") return "wide";
  return "open";
}

/**
 * The mouth timeline of a shot: each word opens the mouth at its start and closes it at its end (the voice is the clock). A
 * mouth closes no later than the next word opens, so the events stay in time order even when two word spans touch or overlap.
 */
export function mouthTimelineOf(shot: Pick<SourceShot, "durationMs" | "words" | "spans">): MouthEvent[] {
  const events: MouthEvent[] = [];
  shot.words.forEach((word, index) => {
    const span = wordSpanOf(shot, index);
    const nextOpens = index + 1 < shot.words.length ? wordSpanOf(shot, index + 1).startMs : span.endMs;
    events.push({ atMs: span.startMs, shape: mouthShapeFor(word) });
    events.push({ atMs: Math.min(span.endMs, nextOpens), shape: "closed" });
  });
  return events;
}

function rigSource(input: BuildSourceInput): SourceResult {
  const sheet = input.character;
  if (sheet === undefined) return refuse("the shot needs the page's rigged character sheet");
  const problem = rigSheetProblem(sheet);
  if (problem !== null) return refuse(problem);
  const play = RIG_PLAY[input.shot.beatRole];
  const pose: RigPose = (sheet.poses ?? []).includes(play.pose) ? play.pose : "idle";
  const visemes = sheet.visemes ?? [];
  const mouth = mouthTimelineOf(input.shot).map((event) => ({
    atMs: event.atMs,
    shape: visemes.includes(event.shape) ? event.shape : "open",
  }));
  return component(
    COMPONENT_FOR.rig,
    {
      rigId: RIG_ID,
      characterId: sheet.characterId,
      position: "center",
      poses: [{ atMs: 0, pose, expression: play.expression }],
      mouth,
    },
    input.shot.durationMs,
    "graphics",
  );
}

/**
 * The screen a screen_mock shot shows, from its own words and the product kit (no invented content): two or more sentences make a
 * chat, one sentence with approved claims makes an app screen of those claims, and one sentence makes a notification from the app.
 */
function screenSource(input: BuildSourceInput): SourceResult {
  const { shot } = input;
  if (shot.words.length === 0) return refuse("the shot speaks no words for the screen to show");
  const kit = input.productKit;
  const hero = kit === undefined ? null : heroUriOf(kit);
  const sentences = sentencesOf(shot.words);
  if (sentences.length >= 2) {
    if (sentences.length > MAX_CHAT_MESSAGES) {
      return refuse(`the shot has ${sentences.length} sentences, and a chat holds ${MAX_CHAT_MESSAGES} messages`);
    }
    const messages = sentences.map((sentence, index) => ({
      side: index % 2 === 0 ? "left" : "right",
      text: sentence.words.join(" "),
      atMs: wordSpanOf(shot, sentence.start).startMs,
    }));
    return component(COMPONENT_FOR.screen, { screen: "chat", messages }, shot.durationMs, "graphics");
  }
  const claims = kit === undefined ? [] : claimTextsOf(kit, input.claimIds);
  if (kit !== undefined && claims.length > 0) {
    const rows = claims.slice(0, MAX_APP_ROWS).map((label) => ({ label }));
    return component(
      COMPONENT_FOR.screen,
      { screen: "app", title: kit.name, rows, ...(hero === null ? {} : { imageUri: hero }) },
      shot.durationMs,
      "graphics",
    );
  }
  if (kit === undefined) return refuse("a one-line screen needs the product's name for its app");
  return component(
    COMPONENT_FOR.screen,
    {
      screen: "notification",
      app: kit.name,
      title: shot.words.join(" "),
      timeLabel: "now",
      ...(hero === null ? {} : { iconUri: hero }),
    },
    shot.durationMs,
    "graphics",
  );
}

/** Why a chain cannot be built, named for the shot: a ShotSource carries one call, so cartoon_generated and stop_motion refuse. */
const CHAIN_REFUSAL = {
  cartoon_generated:
    "cartoon_generated is a chain (a style keyframe, then the video), and a shot source carries one call (sources.ts cartoonGeneratedChain)",
  stop_motion:
    "stop_motion is a chain of frame calls and a player, and a shot source carries one call (sources.ts stopMotionChain)",
} as const;

/** The calls of a cartoon_generated shot (tables.ts GENERATION_CHAINS): the keyframe, then the video that starts from it. */
export type CartoonGeneratedChain = {
  keyframe: { modelClass: "image.keyframe"; prompt: string; refs: string[] };
  video: { modelClass: "video.budget"; prompt: string; refs: string[]; takes: 1 };
};

/** Every character reference is sent with every call (Bible 13). The keyframe is produced first; the video takes it as its first frame. */
export function cartoonGeneratedChain(input: BuildSourceInput): Checked<CartoonGeneratedChain> {
  if (input.prompt === undefined) return { ok: false, reason: "no prompt was written for this cartoon shot" };
  const sheet = input.character;
  if (sheet === undefined || sheet.kind !== "generated") {
    return { ok: false, reason: "the page's generated character sheet is needed" };
  }
  const references = sheet.references ?? [];
  if (references.length === 0) return { ok: false, reason: "the character sheet has no references to send with each call" };
  const prompt = styledPrompt("cartoon_generated", input.prompt);
  return {
    ok: true,
    value: {
      keyframe: { modelClass: "image.keyframe", prompt, refs: [...references] },
      video: { modelClass: "video.budget", prompt, refs: [...references], takes: 1 },
    },
  };
}

/** The frame count and frame rate of a stop-motion shot (7.1): 24 to 36 frames at 8 to 12 per second, from the shot's length. */
export function stopMotionTiming(durationMs: number): Checked<{ frames: number; fps: number }> {
  const seconds = durationMs / 1000;
  const frames = Math.min(STOP_MOTION_FRAMES.max, Math.max(STOP_MOTION_FRAMES.min, Math.round(seconds * STOP_MOTION_FPS.max)));
  const fps = frames / seconds;
  if (fps < STOP_MOTION_FPS.min || fps > STOP_MOTION_FPS.max) {
    return {
      ok: false,
      reason: `a stop-motion shot runs about 2 to 4.5 seconds (${STOP_MOTION_FRAMES.min} to ${STOP_MOTION_FRAMES.max} frames at ${STOP_MOTION_FPS.min} to ${STOP_MOTION_FPS.max} per second), and this one is ${seconds} seconds`,
    };
  }
  return { ok: true, value: { frames, fps: Math.round(fps * 1000) / 1000 } };
}

/** The calls of a stop_motion shot (tables.ts GENERATION_CHAINS): frames from the hero image, then the player that holds them. */
export type StopMotionChain = {
  hero: string;
  frame: { modelClass: "image.edit"; prompt: string; refs: [string] };
  frames: number;
  fps: number;
  player: "stopmotion.player";
};

export function stopMotionChain(input: BuildSourceInput): Checked<StopMotionChain> {
  if (input.prompt === undefined) return { ok: false, reason: "no prompt was written for this stop-motion shot" };
  const hero = input.productKit === undefined ? null : heroUriOf(input.productKit);
  if (hero === null) return { ok: false, reason: "a stop-motion shot starts from the product's hero image" };
  const timing = stopMotionTiming(input.shot.durationMs);
  if (!timing.ok) return timing;
  return {
    ok: true,
    value: {
      hero,
      frame: { modelClass: "image.edit", prompt: styledPrompt("stop_motion", input.prompt), refs: [hero] },
      frames: timing.value.frames,
      fps: timing.value.fps,
      player: "stopmotion.player",
    },
  };
}

/**
 * The source of one shot for its chosen type (6.4 step 4). A type the shot's inputs cannot feed is refused with the reason, so
 * the plan gate can name the shot. Every generated type needs its prompt; stock needs its query.
 */
export function buildSource(input: BuildSourceInput): SourceResult {
  const { shot, visualType } = input;
  if (!timingsFit(shot)) {
    return refuse(TIMINGS_REFUSAL);
  }
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
      const prompt = styledPrompt("cinematic", input.prompt);
      if (shot.showsProduct) {
        if (hero === null) return refuse("a cinematic product shot needs a pinned hero image (7.2 rule 2)");
        return { ok: true, built: { layer: "base", source: generated("video.cinematic", prompt, [hero], 2, hero) } };
      }
      return { ok: true, built: { layer: "base", source: generated("video.cinematic", prompt, [], 2) } };
    }
    case "stock_footage": {
      if (input.query === undefined) return refuse("no search query was written for this stock shot");
      return { ok: true, built: { layer: "base", source: { kind: "stock", query: input.query, minMs: shot.durationMs } } };
    }
    case "kinetic_type": {
      const spoken = emphasisIn(shot.words, shot.emphasis);
      if (spoken.length > 0) {
        return component(
          COMPONENT_FOR.kineticType,
          { lines: timedLinesOf(shot), emphasis: spoken, entrance: "stagger", band: "middle" },
          shot.durationMs,
          "graphics",
        );
      }
      return component(COMPONENT_FOR.kinetic, { lines: kineticLinesOf(shot.words) }, shot.durationMs, "graphics");
    }
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
    case "cartoon_rigged":
      return rigSource(input);
    case "screen_mock":
      return screenSource(input);
    case "cartoon_generated":
    case "stop_motion":
      return refuse(CHAIN_REFUSAL[visualType]);
    default:
      return refuse(`${visualType} has no source in the E3 plan`);
  }
}

/**
 * The component types whose source needs only the shot's own words and timings, the kits and the page's sheet (no planner text).
 * A shot cannot be drawn as these when their source is refused, so build.ts checks them before the planner writes anything.
 */
export const COMPONENT_BUILD_TYPES: readonly VisualType[] = ["kinetic_type", "coded_graphics", "cartoon_rigged", "screen_mock"];

/**
 * The component types this shot cannot be built as, with the reason: each one's source is built here from the shot's words,
 * timings, kits and sheet. Pure. The filter (rule 6) removes these types for the shot, so the planner never picks a type the plan
 * cannot draw, and the plan does not fail later at sources_built.
 */
export function componentBuildRefusals(input: Omit<BuildSourceInput, "visualType">): Partial<Record<VisualType, string>> {
  const refusals: Partial<Record<VisualType, string>> = {};
  for (const visualType of COMPONENT_BUILD_TYPES) {
    const result = buildSource({ ...input, visualType });
    if (!result.ok) refusals[visualType] = result.reason;
  }
  return refusals;
}
