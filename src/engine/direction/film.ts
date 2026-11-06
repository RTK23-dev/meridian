// The directed film: the Director's output, written before anything is generated or drawn (direction lessons L1, L2). It holds the
// look locked for the whole video (L6), and one ShotDirection per shot with the seven parts of direction: the look, the one moment and
// when it hits, anticipation-release-settle, the frame cadence, where the eye goes and the empty space, the loop, and what to avoid (L1).
// It also holds the on-screen cards, the moving numbers, the claims with their sources and the call to action.
//
// Status: this is the proposed ShotDirection contract (docs/engine/proposals/SHOT_DIRECTION.md). It is not yet an engine contract in
// src/engine/contracts/, because a contract change needs the owner's or lead's approval, a version bump and a Bible section 4 note
// (CLAUDE.md rule 4). Until then it is the input of the direction check, the prompt compiler and the code-drawn pixel crew, and it does
// not pass between engine stages.
//
// Times: a film's times are milliseconds from the film's start. A shot's moment and arc times are milliseconds from the shot's start.

import { z } from "zod";
import { hexColourSchema } from "../contracts/primitives.ts";

export const DIRECTED_FILM_SCHEMA = "meridian.directed_film/v1" as const;

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "an id is a short lowercase slug");
const ms = z.int().nonnegative();
const shortText = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0, "must not be blank");
const frac = z.number().min(0).max(1);
const relSpan = z.tuple([ms, ms]).refine(([from, to]) => to >= from, "a span ends at or after its start");

/** How the frame is drawn. The default a model falls into is photoreal; a look names its rendering on purpose (L6). */
export const RENDERINGS = ["pixel_dither", "crisp_vector", "flat_2d", "clay_3d", "voxel", "painterly", "photoreal"] as const;
export const TEXTURES = ["dither", "grain", "scanlines", "halftone", "none"] as const;

export const lookSchema = z.object({
  palette: z.object({
    /** The ground the subject sits on. */
    background: hexColourSchema,
    /** The subject's main colour. */
    hero: hexColourSchema,
    accent: hexColourSchema,
    /** The colour of light: glows, sparks, highlights. */
    glow: hexColourSchema,
    text: hexColourSchema,
    /** The payoff word of a card. */
    keyword: hexColourSchema,
    /** The other colours the worlds may use. Nothing outside the palette is drawn (the crew quantises to it). */
    world: z.array(hexColourSchema).max(16),
    /** Two opposing concepts get two fixed colours for the whole film (L19). */
    concepts: z.array(z.object({ name: shortText(40), colour: hexColourSchema })).max(4),
  }),
  rendering: z.enum(RENDERINGS),
  edges: z.enum(["crisp", "soft"]),
  texture: z.array(z.enum(TEXTURES)).min(1),
  lighting: z.enum(["stylized_glow", "flat", "realistic"]),
  /** The shot whose first frame is made first; every later shot is conditioned on it, so the look holds across shots (L6). */
  referenceShotId: slug,
  notes: shortText(400).optional(),
});
export type Look = z.infer<typeof lookSchema>;

/** What visibly changes at the one moment (L4). */
export const MOMENT_KINDS = [
  "impact",
  "pop",
  "reveal",
  "transform",
  "split",
  "land",
  "grow",
  "shrink",
  "count",
  "flip",
  "release",
  "travel",
] as const;
export const CAMERA_MOVES = ["locked", "push", "pull", "follow", "dive_in", "dive_out", "crane", "pan"] as const;
export const SFX_KINDS = ["pop", "tick", "thud", "whoosh", "zap", "chime", "click", "boom", "beep", "blip", "none"] as const;
export const BANDS = ["top", "bottom", "centre"] as const;
export type Band = (typeof BANDS)[number];

export const shotDirectionSchema = z
  .object({
    shotId: slug,
    startMs: ms,
    endMs: ms,
    /** The words this shot carries, on a card or in the voice. Null for a wordless shot. */
    line: shortText(200).nullable(),
    /** The one literal picture that shows the line (L10). */
    picture: shortText(300),
    /** The world the shot is set in (one setting family per film keeps the look). */
    world: shortText(60),
    /** The one thing the eye follows. */
    subject: shortText(120),
    oneMoment: z.object({
      kind: z.enum(MOMENT_KINDS),
      what: shortText(200),
      /** From the shot's start. */
      hitAtMs: ms,
    }),
    /** Anticipation (the wind-up), release (the hit) and settle (recovery and secondary motion), from the shot's start (L1 03). */
    motionArc: z.object({ anticipationMs: relSpan, releaseMs: relSpan, settleMs: relSpan }),
    motionStyle: z.object({
      /** Character animation held for one, two or three frames; the camera always moves on ones. */
      cadence: z.enum(["ones", "twos", "threes"]),
      smears: z.boolean(),
      squashStretch: z.boolean(),
    }),
    composition: z.object({
      /** Where the eye should be at the moment, as fractions of the frame (0,0 is top left). */
      eyeTarget: z.object({ x: frac, y: frac }),
      /** The subject's height as a fraction of the frame's height. */
      subjectScale: z.number().min(0.03).max(1),
      /** The band left empty for the words. Text never sits over the subject (L7). */
      emptyBand: z.enum(BANDS),
      camera: z.enum(CAMERA_MOVES),
    }),
    loop: z.enum(["none", "seamless", "seam_to_next"]),
    /** Concrete things this shot must not show (L9). */
    avoid: z.array(shortText(80)).min(1).max(12),
    sound: z.object({ hitSfx: z.enum(SFX_KINDS) }),
  })
  .refine((shot) => shot.endMs > shot.startMs, { message: "a shot ends after it starts" });
export type ShotDirection = z.infer<typeof shotDirectionSchema>;

/** A card of on-screen words. At most two lines; the payoff words are the keywords, drawn in the keyword colour. */
export const cardSchema = z
  .object({
    atMs: ms,
    untilMs: ms,
    lines: z.array(shortText(32)).min(1).max(2),
    keywords: z.array(shortText(32)).max(4),
    band: z.enum(BANDS),
    /** A line of the narration, a label in the world, a small source line, or a character's speech bubble. */
    kind: z.enum(["line", "label", "source", "bubble"]),
  })
  .refine((card) => card.untilMs > card.atMs, { message: "a card ends after it appears" });
export type Card = z.infer<typeof cardSchema>;

/** A number that moves on screen (L17): a counter, a running timer, a countdown or a readout. */
export const hudSchema = z
  .object({
    id: slug,
    kind: z.enum(["counter", "timer", "countdown", "readout"]),
    fromMs: ms,
    untilMs: ms,
    from: z.number().finite(),
    to: z.number().finite(),
    unit: z.string().max(16),
    format: z.enum(["int", "thousands", "decimal1", "decimal2", "timer"]),
    band: z.enum(BANDS),
    /** A tick sound on every whole unit while it counts (L11). */
    ticks: z.boolean(),
    /** How long the count runs before it holds on its last value; the whole span when absent. */
    countMs: z.int().positive().optional(),
  })
  .refine((hud) => hud.untilMs > hud.fromMs, { message: "a readout ends after it starts" });
export type Hud = z.infer<typeof hudSchema>;

/** A claim the film makes, with its source. Every number on screen belongs to a claim (L20, L23: the fact-checker's input). */
export const claimSchema = z.object({
  text: shortText(240),
  /** Where it comes from: a named source, or how it was derived from sourced numbers. Null means unsourced, which the check refuses. */
  source: shortText(240).nullable(),
  url: z.string().url().max(500).optional(),
});
export type Claim = z.infer<typeof claimSchema>;

export const directedFilmSchema = z.object({
  schema: z.literal(DIRECTED_FILM_SCHEMA),
  filmId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  /** The one idea the film came from (L3). */
  idea: shortText(200),
  /** The style preset it follows, when one is used. */
  presetId: slug.nullable(),
  durationMs: z.int().positive(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
  /** What sets the timing: the voice track, or the cards when the words are on screen only (L15). */
  clock: z.enum(["voice", "cards"]),
  look: lookSchema,
  shots: z.array(shotDirectionSchema).min(1).max(40),
  cards: z.array(cardSchema).max(80),
  hud: z.array(hudSchema).max(8),
  /** Negatives for every shot, on top of each shot's own (L9). */
  avoidGlobal: z.array(shortText(80)).min(1).max(20),
  claims: z.array(claimSchema).max(30),
  cta: z
    .object({
      kind: z.enum(["share", "comment", "follow", "advice", "safety", "none"]),
      text: shortText(120).nullable(),
      atMs: ms.nullable(),
    })
    .nullable(),
  /** seamless: the last frame runs into the first (measured by loopDistance); thematic: it returns to the opening idea only. */
  loop: z.enum(["seamless", "thematic", "none"]),
});
export type DirectedFilm = z.infer<typeof directedFilmSchema>;

/** The negatives every film carries, whatever the Director adds (L9). */
export const GLOBAL_AVOID: readonly string[] = [
  "muddy or blurred edges",
  "generic glowing orbs or particle soup with no job",
  "a subject that drifts with no reason",
  "lettering, captions, logos or watermarks drawn by a model",
  "extra fingers, extra eyes or melted faces",
  "realistic default colours where the look says otherwise",
];
