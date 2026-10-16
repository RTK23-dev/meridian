// Manifest: the delivered record of one video (Bible section 4.4, 6.14 and 16.3).
// Version 2 (engine-contracts@3) adds the optional roleCalls field: the Claude role calls of the video, from the role-call
// journal (claude/journal.ts), so the manifest can show each call's role, prompt version, model and cost.

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { usdSchema, sumUsd } from "./money.ts";
import { gateResultSchema } from "./gate.ts";
import { decisionSchema, visualTypeSchema } from "./plan.ts";
import { geneIdSchema } from "./request.ts";
import { claudeRoleSchema, promptVersionSchema } from "./ledger.ts";

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

/** The verdict of a role call: its answer was valid, or it was not (the retry or the failure is in the journal). */
export const ROLE_CALL_VERDICTS = ["answered", "invalid_answer"] as const;
export const roleCallVerdictSchema = z.enum(ROLE_CALL_VERDICTS);
export type RoleCallVerdict = z.infer<typeof roleCallVerdictSchema>;

/**
 * One Claude role call, as the role-call journal records it (claude/journal.ts `RoleCall`, with the role added). Unknown
 * values stay null: a null cost is held as the estimate, so actualIsEstimate must be true. An invalid answer is also held as
 * the estimate (the journal's rule), so its actualIsEstimate must be true too.
 */
export const manifestRoleCallSchema = z
  .object({
    role: claudeRoleSchema,
    promptVersion: promptVersionSchema,
    model: z.string().min(1),
    answeredBy: z.string().min(1).nullable(),
    generationId: z.string().min(1).nullable(),
    tokens: z.object({
      prompt: z.int().nonnegative().nullable(),
      completion: z.int().nonnegative().nullable(),
    }),
    costUsd: usdSchema.nullable(),
    actualIsEstimate: z.boolean(),
    verdict: roleCallVerdictSchema,
  })
  .refine((call) => call.promptVersion.startsWith(`${call.role}@`), {
    message: "promptVersion must be a version of role",
  })
  .refine((call) => call.costUsd !== null || call.actualIsEstimate, {
    message: "an unknown cost is held as the estimate, so actualIsEstimate must be true",
  })
  .refine((call) => call.verdict === "answered" || call.actualIsEstimate, {
    message: "an invalid answer is held as the estimate, so actualIsEstimate must be true",
  });
export type ManifestRoleCall = z.infer<typeof manifestRoleCallSchema>;

export const manifestSchema = z
  .object({
    schema: z.literal("meridian.manifest/v2"),
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
    /** Optional (v2): the Claude role calls of the video. Absent means none were recorded. */
    roleCalls: z.array(manifestRoleCallSchema).optional(),
  })
  .refine(
    (manifest) => (manifest.roleCalls ?? []).every((call) => manifest.promptVersions[call.role] === call.promptVersion),
    {
      message: "every role call's promptVersion must be the version recorded for its role in promptVersions",
      path: ["roleCalls"],
    },
  );
export type Manifest = z.infer<typeof manifestSchema>;
