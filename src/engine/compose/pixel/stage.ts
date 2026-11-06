// The pixel crew's build of one shot: what the code-drawn 8-bit renderer (pixel-engine.js) draws. The Director writes the shot's
// direction (direction/film.ts); the crew turns it into a stage of a backdrop, actors with faces, their actions, effects and a camera.
// The crew may not change the direction: direction/faithful.ts checks that the stage lands the one moment at hitAt, keeps the subject
// on the eye target and out of the words' band, and ends where the loop says (L2).
//
// Coordinates are logical pixels of a 180 x 320 frame (9:16), centred: x runs -90 to 90, y runs -160 to 160 at zoom 1. The renderer
// scales the logical frame by a whole number (4 for 720 x 1280, 6 for 1080 x 1920), so a pixel is always the same size on screen and
// the look holds when the camera zooms (the sprites gain pixels; the pixels do not grow).

import { z } from "zod";
import { hexColourSchema } from "../../contracts/primitives.ts";
import { CAMERA_MOVES } from "../../direction/film.ts";

export const LOGICAL_WIDTH = 180;
export const LOGICAL_HEIGHT = 320;

export const BACKDROPS = [
  "night_city",
  "sunset_land",
  "kitchen_night",
  "body_plum",
  "micro_field",
  "fields_night",
  "space",
  "plain",
] as const;

export const SHAPES = [
  "circle",
  "ellipse",
  "roundrect",
  "capsule",
  "blob",
  "droplet",
  "spike",
  "hexagon",
  "star",
  "bubble",
  "box",
  "arrow",
  "ring",
  "cloud",
  "wave",
  "microwave",
  "bowl",
] as const;

export const EXPRESSIONS = ["calm", "happy", "surprised", "strained", "angry", "worried", "sleepy", "smug", "dizzy"] as const;

export const ACTIONS = [
  "enter",
  "exit",
  "move",
  "pop",
  "squash",
  "grow",
  "shrink",
  "rotate",
  "spin",
  "wiggle",
  "jitter",
  "colour",
  "express",
  "blink",
  "shake",
  "bob",
  "glow",
  "mirror",
] as const;

export const FX_KINDS = ["burst", "ring", "steam", "bubbles", "sparks", "flash", "shake", "rain", "waves"] as const;

/** The named curves of the motion kit the renderer knows (compose/motion/kit.ts). */
export const STAGE_CURVES = ["kit.land", "kit.heavy", "kit.whip", "kit.reveal", "kit.leave", "kit.wind", "kit.drift", "linear"] as const;

const ms = z.int().nonnegative();
const coord = z.number().finite().min(-2000).max(2000);
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const actionSchema = z
  .object({
    do: z.enum(ACTIONS),
    atMs: ms,
    durMs: z.int().positive().max(60000),
    to: z
      .object({
        x: coord.optional(),
        y: coord.optional(),
        w: z.number().positive().max(2000).optional(),
        h: z.number().positive().max(2000).optional(),
        rotate: z.number().finite().optional(),
        scale: z.number().positive().max(20).optional(),
        colour: hexColourSchema.optional(),
        expression: z.enum(EXPRESSIONS).optional(),
        alpha: z.number().min(0).max(1).optional(),
      })
      .optional(),
    curve: z.enum(STAGE_CURVES).optional(),
    /** The wind-up before the move, as a fraction of its distance taken backwards first (anticipation). */
    anticipation: z.number().min(0).max(0.6).optional(),
    /** How far it passes the target before it settles (settle). */
    overshoot: z.number().min(0).max(0.6).optional(),
    /** Size of a shake, wiggle, jitter or bob, in logical pixels or degrees. */
    amount: z.number().min(0).max(200).optional(),
    /** Speed of a wiggle, jitter, bob or spin, in cycles a second. */
    hz: z.number().min(0).max(60).optional(),
  })
  .strict();
export type StageAction = z.infer<typeof actionSchema>;

export const actorSchema = z
  .object({
    id: slug,
    shape: z.enum(SHAPES),
    x: coord,
    y: coord,
    w: z.number().positive().max(2000),
    h: z.number().positive().max(2000),
    colour: hexColourSchema,
    /** The shade side of the dither ramp. Default: the colour darkened. */
    shade: hexColourSchema.optional(),
    outline: z.boolean().optional(),
    glow: hexColourSchema.nullable().optional(),
    rotate: z.number().finite().optional(),
    /** Hidden until an enter action, when true. */
    hidden: z.boolean().optional(),
    face: z
      .object({
        expression: z.enum(EXPRESSIONS),
        eyes: z.enum(["two", "one"]).optional(),
        /** The eye radius in logical pixels. Default: from the actor's size. */
        size: z.number().positive().max(40).optional(),
        /** Where the pupils look, -1 to 1 on each axis. */
        look: z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)]).optional(),
      })
      .optional(),
    label: z.object({ text: z.string().min(1).max(24), side: z.enum(["above", "below", "left", "right"]), colour: hexColourSchema.optional() }).optional(),
    /** A field of copies (molecules, cells, windows), each with its own small offset. */
    repeat: z
      .object({
        cols: z.int().min(1).max(40),
        rows: z.int().min(1).max(40),
        dx: z.number(),
        dy: z.number(),
        jitter: z.number().min(0).max(20).optional(),
        /** The first copy leads; the others react up to this many ms later, unevenly (the motion kit's react). */
        stagger: z.int().min(0).max(2000).optional(),
        /** Each copy starts turned by up to half this many degrees either way. */
        spin: z.number().min(0).max(360).optional(),
      })
      .optional(),
    z: z.int().min(-50).max(50).optional(),
    actions: z.array(actionSchema).max(40),
  })
  .strict();
export type StageActor = z.infer<typeof actorSchema>;

export const fxSchema = z
  .object({
    kind: z.enum(FX_KINDS),
    atMs: ms,
    durMs: z.int().positive().max(60000),
    x: coord,
    y: coord,
    colour: hexColourSchema,
    count: z.int().min(1).max(200).optional(),
    size: z.number().positive().max(400).optional(),
  })
  .strict();
export type StageFx = z.infer<typeof fxSchema>;

const viewSchema = z.object({ x: coord, y: coord, zoom: z.number().min(0.05).max(40) }).strict();

export const stageSchema = z
  .object({
    shotId: slug,
    /** The actor the shot's direction names as its subject: the one the eye follows. */
    subjectId: slug,
    backdrop: z
      .object({
        kind: z.enum(BACKDROPS),
        /** Overrides of the backdrop's colours, darkest first. */
        colours: z.array(hexColourSchema).max(8).optional(),
        seed: z.int().min(0).max(1_000_000).optional(),
      })
      .strict(),
    camera: z
      .object({
        move: z.enum(CAMERA_MOVES),
        from: viewSchema,
        to: viewSchema,
        /** The part of the shot the move takes; the whole shot when absent. */
        atMs: ms.optional(),
        durMs: z.int().positive().optional(),
        curve: z.enum(STAGE_CURVES).optional(),
      })
      .strict(),
    actors: z.array(actorSchema).max(60),
    fx: z.array(fxSchema).max(40),
  })
  .strict();
export type Stage = z.infer<typeof stageSchema>;

/** The stages of a film, one per shot, in the shots' order. */
export const pixelBuildSchema = z.object({
  schema: z.literal("meridian.pixel_build/v1"),
  filmId: z.string().min(1),
  stages: z.array(stageSchema).min(1).max(40),
});
export type PixelBuild = z.infer<typeof pixelBuildSchema>;
