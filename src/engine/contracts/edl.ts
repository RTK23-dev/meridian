// Edit decision list: the deterministic cut of the video (Bible section 4.4 and 8).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { msSchema, positiveMsSchema, SPAN_MESSAGE, spanOk } from "./primitives.ts";

export const EDL_LAYERS = ["base", "cutaway", "presenter", "graphics", "captions", "stickers"] as const;
export const edlLayerSchema = z.enum(EDL_LAYERS);
export type EdlLayer = z.infer<typeof edlLayerSchema>;

export const EFFECT_KINDS = ["punch_in", "shake", "speed_ramp", "flash"] as const;

/**
 * The whole-frame looks a repurposed cut may use. The compiler owns each look's colour, blend mode and opacity (compose/compiler.ts), so a look
 * is a preset name, never free CSS.
 */
export const LOOK_PRESETS = ["warm", "cool", "faded", "mono"] as const;
export type LookPreset = (typeof LOOK_PRESETS)[number];

/**
 * The visual treatments of a repurposed cut (contract v11). They change the footage only: the base, cutaway and presenter clips take the
 * mirror and the framing, and the look, grain and vignette are drawn over the footage and under the graphics and captions. Each number is
 * bounded here, so the compiler never receives a value outside the range a repurpose may use. A cut without treatments has no `visual`.
 */
export const visualTreatmentSchema = z
  .object({
    version: z.literal(1),
    look: z.object({ preset: z.enum(LOOK_PRESETS), strength: z.number().min(0).max(1) }).strict().optional(),
    framing: z
      .object({
        zoom: z.number().min(1).max(1.12),
        rotationDeg: z.number().min(-2).max(2),
        offsetXPct: z.number().min(-3).max(3),
        offsetYPct: z.number().min(-3).max(3),
      })
      .strict()
      .optional(),
    mirror: z.boolean().optional(),
    grain: z.object({ strength: z.number().min(0).max(1) }).strict().optional(),
    vignette: z.object({ strength: z.number().min(0).max(1) }).strict().optional(),
  })
  .strict();
export type VisualTreatment = z.infer<typeof visualTreatmentSchema>;

export const audioClipBaseSchema = z.object({
  uri: z.string().min(1),
  startMs: msSchema,
  endMs: msSchema,
  gainDb: z.number().finite(),
});

export const audioClipSchema = audioClipBaseSchema.refine(spanOk, { message: SPAN_MESSAGE });
export type AudioClip = z.infer<typeof audioClipSchema>;

export const musicClipSchema = audioClipBaseSchema
  .extend({ duckDb: z.number().finite() })
  .refine(spanOk, { message: SPAN_MESSAGE });
export type MusicClip = z.infer<typeof musicClipSchema>;

export const edlClipSchema = z
  .object({
    clipId: z.string().min(1),
    startMs: msSchema,
    endMs: msSchema,
    srcUri: z.string().min(1).optional(),
    srcInMs: msSchema.optional(),
    component: z.string().min(1).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    transitionIn: z.string().min(1).optional(),
    box: z
      .object({
        x: z.number().nonnegative().finite(),
        y: z.number().nonnegative().finite(),
        w: z.number().nonnegative().finite(),
        h: z.number().nonnegative().finite(),
      })
      .optional(),
  })
  .refine(spanOk, { message: SPAN_MESSAGE });
export type EdlClip = z.infer<typeof edlClipSchema>;

export const edlSchema = z.object({
  schema: z.literal("meridian.edl/v1"),
  edlId: idSchema("edl_"),
  requestId: idSchema("req_"),
  variantOf: z.string().min(1).optional(),
  durationMs: positiveMsSchema,
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  tracks: z.array(
    z.object({
      layer: edlLayerSchema,
      clips: z.array(edlClipSchema),
    }),
  ),
  audio: z.object({
    voice: audioClipSchema,
    music: musicClipSchema.optional(),
    sfx: z.array(audioClipSchema),
    masterLufs: z.literal(-14),
  }),
  effects: z.array(
    z.object({
      atMs: msSchema,
      kind: z.enum(EFFECT_KINDS),
      params: z.record(z.string(), z.number().finite()),
    }),
  ),
  // The visual treatments of a repurposed cut (contract v11). Absent on every other cut, so an earlier EDL parses unchanged.
  visual: visualTreatmentSchema.optional(),
  seed: z.int().nonnegative().max(0xffffffff),
});
export type EditDecisionList = z.infer<typeof edlSchema>;
