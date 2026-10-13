// Gate results and the post-render review (Bible section 4.4, 5.3 and 12).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { allChecksPass, PASS_MESSAGE } from "./primitives.ts";
import { edlLayerSchema } from "./edl.ts";

export const GATE_IDS = [
  "request",
  "dna",
  "voice",
  "plan",
  "budget",
  "take",
  "edit",
  "pre_render",
  "render_integrity",
  "post_render",
] as const;

export const gateIdSchema = z.enum(GATE_IDS);
export type GateId = z.infer<typeof gateIdSchema>;

export const gateCheckSchema = z.object({
  rule: z.string().min(1),
  pass: z.boolean(),
  value: z.number().finite().optional(),
  limit: z.number().finite().optional(),
  detail: z.string().min(1).optional(),
});
export type GateCheck = z.infer<typeof gateCheckSchema>;

const gateResultFields = z.object({
  gate: gateIdSchema,
  subjectId: z.string().min(1),
  pass: z.boolean(),
  checks: z.array(gateCheckSchema).min(1),
  failingShotIds: z.array(idSchema("shot_")).optional(),
});

export const gateResultSchema = gateResultFields.refine((result) => result.pass === allChecksPass(result.checks), {
  message: PASS_MESSAGE,
});
export type GateResult = z.infer<typeof gateResultSchema>;

const postRenderResultSchema = gateResultFields
  .extend({ gate: z.literal("post_render") })
  .refine((result) => result.pass === allChecksPass(result.checks), { message: PASS_MESSAGE });

export const reviewResultSchema = z
  .object({
    schema: z.literal("meridian.review_result/v1"),
    videoId: idSchema("vid_"),
    result: postRenderResultSchema,
    failures: z.array(
      z.object({
        rule: z.string().min(1),
        shotId: idSchema("shot_").optional(),
        layer: edlLayerSchema.optional(),
      }),
    ),
  })
  .refine((review) => !review.result.pass || review.failures.length === 0, {
    message: "a passing review has no failures",
  });
export type ReviewResult = z.infer<typeof reviewResultSchema>;
