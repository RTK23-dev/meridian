// Scene plan, shots and decisions (Bible section 4.3).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { usdSchema } from "./money.ts";
import { msSchema, SPAN_MESSAGE, spanOk } from "./primitives.ts";

export const VISUAL_TYPES = [
  "ugc_presenter",
  "product_hero",
  "stock_footage",
  "cinematic",
  "cartoon_rigged",
  "cartoon_generated",
  "coded_graphics",
  "react_clip",
  "kinetic_type",
  "stop_motion",
  "screen_mock",
] as const;

export const visualTypeSchema = z.enum(VISUAL_TYPES);
export type VisualType = z.infer<typeof visualTypeSchema>;

export const MODEL_CLASSES = [
  "video.cinematic",
  "video.budget",
  "video.i2v_pinned",
  "avatar",
  "image.keyframe",
  "image.edit",
  "tts",
  "lipsync",
] as const;

export const modelClassSchema = z.enum(MODEL_CLASSES);
export type ModelClass = z.infer<typeof modelClassSchema>;

export const SHOT_LAYERS = ["base", "cutaway", "presenter", "graphics"] as const;
export const shotLayerSchema = z.enum(SHOT_LAYERS);
export type ShotLayer = z.infer<typeof shotLayerSchema>;

/** Who made a logged choice (Bible L7). `editor` (contract v4) is the deterministic editor of Bible 8.2. */
export const DECISION_AUTHORS = ["scorer", "director", "human", "editor"] as const;
export const decisionAuthorSchema = z.enum(DECISION_AUTHORS);
export type DecisionAuthor = z.infer<typeof decisionAuthorSchema>;

/**
 * One logged choice with its reason (Bible L7). `at` is the id of the subject: a beat or a shot for the planner and the
 * director, and an EDL clip id (`EdlClip.clipId`) for the editor (contract v4). Editor decisions with no alternative set
 * use an empty `alternatives` list; a score is never invented.
 */
export const decisionSchema = z.object({
  at: z.string().min(1),
  chose: z.string().min(1),
  alternatives: z.array(z.object({ option: z.string().min(1), score: z.number().finite() })),
  reason: z.string().min(1),
  by: decisionAuthorSchema,
});
export type Decision = z.infer<typeof decisionSchema>;

const generateSourceSchema = z.object({
  kind: z.literal("generate"),
  modelClass: modelClassSchema,
  prompt: z.string().min(1),
  refs: z.array(z.string().min(1)),
  firstFrame: z.string().min(1).optional(),
  lastFrame: z.string().min(1).optional(),
  takes: z.union([z.literal(1), z.literal(2)]),
});

const componentSourceSchema = z.object({
  kind: z.literal("component"),
  component: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
});

const stockSourceSchema = z.object({
  kind: z.literal("stock"),
  query: z.string().min(1),
  minMs: z.int().positive(),
});

const assetSourceSchema = z.object({
  kind: z.literal("asset"),
  assetUri: z.string().min(1),
});

export const shotSourceSchema = z.discriminatedUnion("kind", [
  generateSourceSchema,
  componentSourceSchema,
  stockSourceSchema,
  assetSourceSchema,
]);
export type ShotSource = z.infer<typeof shotSourceSchema>;

export const shotSpecSchema = z
  .object({
    shotId: idSchema("shot_"),
    beatId: z.string().min(1),
    startMs: msSchema,
    endMs: msSchema,
    visualType: visualTypeSchema,
    layer: shotLayerSchema,
    source: shotSourceSchema,
    mustSatisfy: z.string().min(1).optional(),
    downgradeTo: visualTypeSchema.optional(),
  })
  .refine(spanOk, { message: SPAN_MESSAGE });
export type ShotSpec = z.infer<typeof shotSpecSchema>;

export const scenePlanSchema = z.object({
  schema: z.literal("meridian.scene_plan/v1"),
  planId: z.string().min(1),
  requestId: idSchema("req_"),
  videoDnaId: idSchema("dna_"),
  voiceTrackId: z.string().min(1),
  shots: z.array(shotSpecSchema),
  estimatedUsd: usdSchema,
  decisions: z.array(decisionSchema),
});
export type ScenePlan = z.infer<typeof scenePlanSchema>;
