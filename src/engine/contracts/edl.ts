// Edit decision list: the deterministic cut of the video (Bible section 4.4 and 8).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { msSchema, positiveMsSchema, SPAN_MESSAGE, spanOk } from "./primitives.ts";

export const EDL_LAYERS = ["base", "cutaway", "presenter", "graphics", "captions", "stickers"] as const;
export const edlLayerSchema = z.enum(EDL_LAYERS);
export type EdlLayer = z.infer<typeof edlLayerSchema>;

export const EFFECT_KINDS = ["punch_in", "shake", "speed_ramp", "flash"] as const;

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
  seed: z.int().nonnegative().max(0xffffffff),
});
export type EditDecisionList = z.infer<typeof edlSchema>;
