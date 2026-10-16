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

// --- Chains (contract v5, Bible section 4 "v5 changes and migration"). A shot whose source is several paid calls. Each call
// reads its inputs, which are assets or the outputs of earlier calls of the same chain, and every call is priced.

/** A chain has at least two calls. One call is a generate source. */
export const CHAIN_MIN_CALLS = 2;

/** An output name: a call makes it, and a later call of the same chain reads it. Lower case, so it is never an asset uri. */
export const chainOutputNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, {
  message: "an output name is lower-case letters, digits and underscores, starting with a letter, at most 40 characters",
});

/** An input of a chain call: an asset (a store uri, a kit image or a hero image), or the output of an earlier call. */
export const chainInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), uri: z.string().min(1) }),
  z.object({ kind: z.literal("output"), output: chainOutputNameSchema }),
]);
export type ChainInput = z.infer<typeof chainInputSchema>;

/** One paid call of a chain. `output` is the name later calls read. `takes` is the take count, as for a generate source. */
export const chainCallSchema = z.object({
  output: chainOutputNameSchema,
  modelClass: modelClassSchema,
  prompt: z.string().min(1),
  refs: z.array(chainInputSchema),
  firstFrame: chainInputSchema.optional(),
  lastFrame: chainInputSchema.optional(),
  takes: z.union([z.literal(1), z.literal(2)]),
});
export type ChainCall = z.infer<typeof chainCallSchema>;

/** The inputs one call reads: its refs, then its first and last frame when it has them. */
export function chainInputsOf(call: ChainCall): ChainInput[] {
  const frames = [call.firstFrame, call.lastFrame].filter((input): input is ChainInput => input !== undefined);
  return [...call.refs, ...frames];
}

/**
 * The first problem in a chain, or null. Output names are unique. An input that names an output must name one that an
 * EARLIER call of the same chain makes: an unknown name, a name a later call makes, or the call's own name is refused.
 */
export function chainProblem(calls: readonly ChainCall[]): { index: number; message: string } | null {
  const madeBefore = new Set<string>();
  for (const [index, call] of calls.entries()) {
    for (const input of chainInputsOf(call)) {
      if (input.kind === "output" && !madeBefore.has(input.output)) {
        return { index, message: `call "${call.output}" refers to output "${input.output}", which no earlier call of this chain makes` };
      }
    }
    if (madeBefore.has(call.output)) {
      return { index, message: `output "${call.output}" is made by more than one call of this chain` };
    }
    madeBefore.add(call.output);
  }
  return null;
}

const chainSourceSchema = z
  .object({
    kind: z.literal("chain"),
    calls: z.array(chainCallSchema).min(CHAIN_MIN_CALLS),
  })
  .superRefine((source, ctx) => {
    const problem = chainProblem(source.calls);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem.message, path: ["calls", problem.index] });
  });
export type ChainSource = z.infer<typeof chainSourceSchema>;

export const shotSourceSchema = z.discriminatedUnion("kind", [
  generateSourceSchema,
  componentSourceSchema,
  stockSourceSchema,
  assetSourceSchema,
  chainSourceSchema,
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
