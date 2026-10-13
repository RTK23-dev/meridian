// Reference analysis: Video DNA, words, segments and the edit grammar (Bible sections 4.1 and 4.2, 8.1).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { beatRoleSchema, geneIdSchema } from "./request.ts";
import { msSchema, positiveMsSchema, SPAN_MESSAGE, spanOk } from "./primitives.ts";

export const REFERENCE_SHOT_TYPES = [
  "talking_head",
  "broll_montage",
  "product_closeup",
  "onscreen_list",
  "sketch_joke",
  "spectacle",
  "screen_record",
  "react",
  "text_only",
  "other",
] as const;
export const referenceShotTypeSchema = z.enum(REFERENCE_SHOT_TYPES);
export type ReferenceShotType = z.infer<typeof referenceShotTypeSchema>;

export const wordSchema = z
  .object({
    wordId: z.string().min(1),
    text: z.string().min(1),
    startMs: msSchema,
    endMs: msSchema,
    confidence: z.number().min(0).max(1),
  })
  .refine(spanOk, { message: SPAN_MESSAGE });
export type Word = z.infer<typeof wordSchema>;

export const dnaSegmentSchema = z
  .object({
    segId: z.string().min(1),
    startMs: msSchema,
    endMs: msSchema,
    wordIds: z.array(z.string().min(1)),
    shotType: referenceShotTypeSchema,
    layers: z.object({
      base: z.string().min(1).optional(),
      presenter: z.string().min(1).optional(),
      broll: z.string().min(1).optional(),
      graphics: z.string().min(1).optional(),
      captions: z.string().min(1).optional(),
    }),
    onScreenText: z.string().min(1).optional(),
    beatRole: beatRoleSchema.optional(),
    motion: z.number().nonnegative().finite(),
    brightness: z.number().min(0).max(1),
    loudnessLufs: z.number().finite(),
  })
  .refine(spanOk, { message: SPAN_MESSAGE });
export type DnaSegment = z.infer<typeof dnaSegmentSchema>;

const tenths = z.array(z.number().finite()).length(10);

export const editGrammarSchema = z.object({
  hookFirstCutMs: msSchema,
  hookPayoffMs: msSchema,
  shotLengthMs: z.object({
    p25: msSchema,
    p50: msSchema,
    p75: msSchema,
    curve: tenths, // median shot length in each tenth of the video
  }),
  rehookIntervalMs: positiveMsSchema,
  captions: z.object({
    wordsPerCaption: z
      .tuple([z.int().positive(), z.int().positive()])
      .refine(([low, high]) => low <= high, { message: "wordsPerCaption must be [min, max]" }),
    position: z.enum(["upper", "middle", "lower"]),
    style: z.string().min(1),
    highlightCurrentWord: z.boolean(),
  }),
  motion: z.object({
    punchInsPer10s: z.number().nonnegative().finite(),
    punchInScale: z.number().positive().finite(),
    shakeOnImpact: z.boolean(),
    speedRamps: z.boolean(),
  }),
  transitions: z.array(
    z.object({
      kind: z.string().min(1),
      share: z.number().min(0).max(1),
    }),
  ),
  sound: z.object({
    music: z.boolean(),
    bpm: z.number().positive().finite().optional(),
    energyCurve: tenths,
    sfxPer10s: z.number().nonnegative().finite(),
    silenceBeforePayoffMs: msSchema.optional(),
  }),
  endsOnLoop: z.boolean(),
});
export type EditGrammar = z.infer<typeof editGrammarSchema>;

export const videoDnaSchema = z.object({
  schema: z.literal("meridian.video_dna/v1"),
  videoDnaId: idSchema("dna_"),
  formatId: z.string().min(1),
  sourceRef: z.string().min(1),
  durationMs: positiveMsSchema,
  transcript: z.object({ words: z.array(wordSchema) }),
  segments: z.array(dnaSegmentSchema),
  genome: z.partialRecord(geneIdSchema, z.string().min(1)),
  editGrammar: editGrammarSchema,
  transferable: z.array(geneIdSchema),
  notTransferable: z.array(z.string().min(1)),
  sourceDeletedAt: z.iso.datetime().optional(),
});
export type VideoDNA = z.infer<typeof videoDnaSchema>;
