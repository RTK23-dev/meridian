// The content plan (framework 18; Kallaway lessons 64 to 100): what each video in a run of videos is for, before any one is written. A
// video's direction starts from its slot: its subtopic, its format, its layout, how far from the brand's bullseye viewer it aims, and its
// one job. Then the plan learns: the brand's outliers are remixed one brick at a time and reposted after a few months, and the view
// ceiling says which lever to pull next.
//
// The grids and mixes are one creator's methods (`practice`); the job mixes per content game are this codex's reading of them
// (`hypothesis`). The learning loop replaces both with the brand's own results. Pure and deterministic.

import { VIEW_CEILINGS, type ContentGame, type FormatId, type VideoJob } from "./codex.ts";

/** How far a video aims from the bullseye viewer: 5 is the bullseye (the narrowest buyer), 1 the broadest ring (never used). */
export type Ring = 1 | 2 | 3 | 4 | 5;

export type PlanSlot = {
  index: number;
  subtopic: string;
  format: FormatId;
  layout: string;
  ring: Ring;
  job: VideoJob;
  audience: "broad" | "narrow";
};

export const GRID_METHODS = {
  /** 6 subtopics x 5 formats, one layout: 30 days. */
  "6x5": { subtopics: 6, formats: 5, layouts: 1 },
  /** 5 subtopics x 3 formats (two simple, one complex) x 2 layouts: 30 days. */
  "532": { subtopics: 5, formats: 3, layouts: 2 },
  /** 3 subtopics x 3 formats (two easy, one ambitious): 9 videos, then a tenth that doubles down on the best. */
  "331": { subtopics: 3, formats: 3, layouts: 1 },
} as const;
export type GridMethod = keyof typeof GRID_METHODS;

/**
 * The job of each place in a week of seven videos, per content game (a reading of the five games and the 3-2-2 bullseye). Authority-driven
 * services take 3 bullseye videos to convert, 2 to earn follows and 2 to reach; entertainment plays almost only for reach.
 */
export const JOB_WEEK: Record<ContentGame, readonly VideoJob[]> = {
  entertainment_media: ["reach", "reach", "follow", "reach", "reach", "follow", "reach"],
  commodity_product: ["reach", "reach", "convert", "reach", "follow", "reach", "reach"],
  education_media: ["reach", "follow", "reach", "convert", "follow", "reach", "follow"],
  explanatory_product: ["reach", "convert", "follow", "reach", "convert", "follow", "reach"],
  authority_services: ["convert", "follow", "convert", "reach", "convert", "follow", "reach"],
};

const RING_OF_JOB: Record<VideoJob, Ring> = { convert: 5, follow: 4, reach: 2 };

/** The bullseye rings of a week of seven (3-2-2): three at the bullseye, two at rings 3 and 4, two at ring 2, none at ring 1. */
export const BULLSEYE_WEEK: readonly Ring[] = [5, 4, 5, 2, 5, 3, 2];

/**
 * A calendar grid: every subtopic meets every format (and layout) once, ordered so that consecutive videos change subtopic. The jobs follow
 * the content game's week, and the ring and audience follow the job (the virality stack: broad to reach, narrow to convert).
 */
export function contentGrid(input: { method: GridMethod; subtopics: readonly string[]; formats: readonly FormatId[]; layouts?: readonly string[]; game: ContentGame }): PlanSlot[] {
  const shape = GRID_METHODS[input.method];
  const layouts = input.layouts && input.layouts.length > 0 ? input.layouts : ["default"];
  if (input.subtopics.length < shape.subtopics) throw new Error(`The ${input.method} method needs ${shape.subtopics} subtopics; ${input.subtopics.length} were given.`);
  if (input.formats.length < shape.formats) throw new Error(`The ${input.method} method needs ${shape.formats} formats; ${input.formats.length} were given.`);
  if (layouts.length < shape.layouts) throw new Error(`The ${input.method} method needs ${shape.layouts} layouts; ${layouts.length} were given.`);

  const cells: { subtopic: number; format: number; layout: number }[] = [];
  const total = shape.subtopics * shape.formats * shape.layouts;
  for (let index = 0; index < total; index += 1) {
    const subtopic = index % shape.subtopics;
    const round = Math.floor(index / shape.subtopics);
    if (input.method === "6x5") {
      // (2 x round + subtopic) mod 5 visits each format once per subtopic, because 2 has an inverse mod 5.
      cells.push({ subtopic, format: (2 * round + subtopic) % shape.formats, layout: 0 });
    } else {
      cells.push({ subtopic, format: round % shape.formats, layout: Math.floor(round / shape.formats) % shape.layouts });
    }
  }

  const week = JOB_WEEK[input.game];
  return cells.map((cell, index) => {
    const job = week[index % week.length]!;
    return {
      index,
      subtopic: input.subtopics[cell.subtopic]!,
      format: input.formats[cell.format]!,
      layout: layouts[cell.layout]!,
      job,
      ring: RING_OF_JOB[job],
      audience: job === "convert" ? "narrow" : "broad",
    };
  });
}

/** The 3-2-1 week for a business owner: one broad bucket and two narrow ones on core pains, twice each, and a seventh to triple down or test. */
export const WEEK_321 = ["broad", "narrow_1", "narrow_2", "broad", "narrow_1", "narrow_2", "triple_down_or_test"] as const;

export type Post = { id: string; views: number; postedAt: string };

/**
 * A post's multiple of the account's typical views, and the posts at or above `factor` (5x by default), highest first. Typical is the
 * median, not the mean: a few big hits would raise the mean until no hit counts as one (the Factory's breakout score also reads the
 * creator's median).
 */
export function outliers(posts: readonly Post[], factor = 5): { post: Post; multiple: number }[] {
  const counted = posts.filter((post) => Number.isFinite(post.views) && post.views >= 0);
  if (counted.length === 0) return [];
  const sorted = counted.map((post) => post.views).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const typical = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  if (typical === 0) return [];
  return counted
    .map((post) => ({ post, multiple: post.views / typical }))
    .filter((entry) => entry.multiple >= factor)
    .sort((a, b) => b.multiple - a.multiple);
}

const DAY_MS = 86_400_000;

/**
 * The brand's own outliers old enough to post again (four months by default): change a couple of things, a picture or the text's place,
 * and post it as new. Only the brand's own videos: another creator's never are.
 */
export function repostCandidates(posts: readonly Post[], now: string, options: { factor?: number; minDays?: number } = {}): { post: Post; multiple: number; ageDays: number }[] {
  const minDays = options.minDays ?? 120;
  const at = Date.parse(now);
  return outliers(posts, options.factor ?? 5)
    .map((entry) => ({ ...entry, ageDays: Math.floor((at - Date.parse(entry.post.postedAt)) / DAY_MS) }))
    .filter((entry) => Number.isFinite(entry.ageDays) && entry.ageDays >= minDays);
}

/** The bricks of a video (the Lego brick method). */
export const BRICKS = ["topic", "angle", "format", "hook", "visuals"] as const;
export type Brick = (typeof BRICKS)[number];
export type Bricks = Record<Brick, string>;

/**
 * Variations of a winning video: each brick either kept or swapped for one of its alternatives. Variations that change the fewest bricks
 * come first (change one thing at a time, so the data says which brick mattered); the winner itself is not returned. With three options
 * per brick there are 3^5 - 1 = 242 variations.
 */
export function legoVariations(winner: Bricks, alternatives: Partial<Record<Brick, readonly string[]>>, limit = 20): { bricks: Bricks; changed: Brick[] }[] {
  let combos: { bricks: Bricks; changed: Brick[] }[] = [{ bricks: { ...winner }, changed: [] }];
  for (const brick of BRICKS) {
    const options = [...new Set((alternatives[brick] ?? []).filter((option) => option !== winner[brick]))];
    combos = combos.flatMap((combo) => [combo, ...options.map((option) => ({ bricks: { ...combo.bricks, [brick]: option }, changed: [...combo.changed, brick] }))]);
  }
  return combos
    .filter((combo) => combo.changed.length > 0)
    .sort((a, b) => a.changed.length - b.changed.length)
    .slice(0, Math.max(0, limit));
}

/** Which lever to pull at a median of `medianViews` per video. */
export function viewCeiling(medianViews: number): { below: number | null; fix: string } {
  const ceiling = VIEW_CEILINGS.find((entry) => medianViews < entry.below);
  return ceiling ? { below: ceiling.below, fix: ceiling.fix } : { below: null, fix: "Past every ceiling: keep the topics and angles that got here, and protect the audience match." };
}

/** Where an account is in quality versus quantity (lesson 82), by the number of videos it has posted. */
export function qualityPhase(videosPosted: number): { phase: 1 | 2 | 3; advice: string } {
  if (videosPosted < 40) return { phase: 1, advice: "Quantity, learning from every video: before about 40, results are mostly luck." };
  if (videosPosted < 100) return { phase: 2, advice: "Three to seven a week, raising quality to the level of the best creator in the category." };
  return { phase: 3, advice: "Hold that quality floor and raise the volume step by step." };
}
