// Manifest: the delivered record of one video (Bible section 4.4, 6.14 and 16.3).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { usdSchema, sumUsd } from "./money.ts";
import { gateResultSchema } from "./gate.ts";
import { decisionSchema, visualTypeSchema } from "./plan.ts";
import { geneIdSchema } from "./request.ts";

export const costBreakdownSchema = z
  .object({
    brain: usdSchema,
    generation: usdSchema,
    render: usdSchema,
    other: usdSchema,
    total: usdSchema,
  })
  .refine((cost) => cost.total === sumUsd([cost.brain, cost.generation, cost.render, cost.other]), {
    message: "cost.total must equal brain + generation + render + other",
  });
export type CostBreakdown = z.infer<typeof costBreakdownSchema>;

export const manifestSchema = z.object({
  schema: z.literal("meridian.manifest/v1"),
  videoId: idSchema("vid_"),
  requestId: idSchema("req_"),
  variantOf: z.string().min(1).optional(),
  formatId: z.string().min(1),
  videoDnaId: idSchema("dna_"),
  genome: z.partialRecord(geneIdSchema, z.string().min(1)),
  promptVersions: z.record(z.string(), z.string().min(1)),
  shots: z.array(
    z.object({
      shotId: idSchema("shot_"),
      visualType: visualTypeSchema,
      takeId: idSchema("take_"),
      provider: z.string().min(1),
      model: z.string().min(1),
      attempts: z.int().positive(),
    }),
  ),
  gates: z.array(gateResultSchema),
  decisions: z.array(decisionSchema),
  cost: costBreakdownSchema,
  disclosures: z.object({
    aiGeneratedPeople: z.boolean(),
    paidPartnership: z.boolean(),
  }),
  timings: z.record(z.string(), z.int().nonnegative()),
});
export type Manifest = z.infer<typeof manifestSchema>;
