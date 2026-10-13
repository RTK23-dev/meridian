// Takes (one generated or sourced clip per attempt) and the verdict on each take (Bible section 4.3, 6.6, 6.7).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { contentHashSchema } from "./hash.ts";
import { usdSchema } from "./money.ts";
import { allChecksPass, msSchema, positiveMsSchema, PASS_MESSAGE } from "./primitives.ts";

export const takeSchema = z.object({
  schema: z.literal("meridian.take/v1"),
  takeId: idSchema("take_"),
  shotId: idSchema("shot_"),
  attempt: z.int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  uri: z.string().min(1),
  durationMs: positiveMsSchema,
  width: z.int().positive(),
  height: z.int().positive(),
  promptHash: contentHashSchema,
  costUsd: usdSchema,
  latencyMs: msSchema,
});
export type Take = z.infer<typeof takeSchema>;

export const takeCheckSchema = z.object({
  rule: z.string().min(1),
  pass: z.boolean(),
  score: z.number().finite().optional(),
  detail: z.string().min(1).optional(),
  atMs: msSchema.optional(),
});
export type TakeCheck = z.infer<typeof takeCheckSchema>;

export const TAKE_ACTIONS = ["accept", "redo", "downgrade", "escalate"] as const;

export const takeVerdictSchema = z
  .object({
    takeId: idSchema("take_"),
    pass: z.boolean(),
    confidence: z.number().min(0).max(1),
    checks: z.array(takeCheckSchema).min(1),
    action: z.enum(TAKE_ACTIONS),
  })
  .refine((verdict) => verdict.pass === allChecksPass(verdict.checks), { message: PASS_MESSAGE });
export type TakeVerdict = z.infer<typeof takeVerdictSchema>;
