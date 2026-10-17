// Production request, validated request and intake rejection (Bible sections 4.1 and 6.1).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { usdSchema } from "./money.ts";
import { kitRefSchema } from "./kits.ts";
import { nonBlankText, positiveMsSchema } from "./primitives.ts";

export const BEAT_ROLES = ["hook", "setup", "item", "proof", "twist", "payoff", "cta"] as const;
export const beatRoleSchema = z.enum(BEAT_ROLES);
export type BeatRole = z.infer<typeof beatRoleSchema>;

export const GENE_IDS = [
  "hook_mechanism",
  "voice_persona",
  "emotional_arc",
  "structure",
  "proof_device",
  "edit_grammar",
  "conversion_move",
  "pacing",
  "caption_style",
] as const;
export const geneIdSchema = z.enum(GENE_IDS);
export type GeneId = z.infer<typeof geneIdSchema>;

export const PRIORITIES = ["rush", "normal", "batch"] as const;

export const scriptBeatSchema = z.object({
  beatId: z.string().min(1),
  role: beatRoleSchema,
  text: z.string().min(1),
  emphasis: z.array(z.string().min(1)).optional(),
});
export type ScriptBeat = z.infer<typeof scriptBeatSchema>;

// --- The brief (contract v8). A request sends either its script (the words to speak) or a brief, from which the engine writes the
// script after analyze_reference (Bible 6.x write_script). The limits are the brief's own; they are contract values, not tuning.

export const BRIEF_TEXT_MAX = 8000;
export const BRIEF_SOURCE_LABEL_MAX = 200;
export const BRIEF_SOURCE_TEXT_MAX = 4000;
export const BRIEF_ATTACHMENT_NOTE_MAX = 500;
export const BRIEF_LIST_MAX = 20;

export const briefSourceSchema = z.object({
  label: nonBlankText(BRIEF_SOURCE_LABEL_MAX),
  text: nonBlankText(BRIEF_SOURCE_TEXT_MAX),
});
export type BriefSource = z.infer<typeof briefSourceSchema>;

export const briefAttachmentSchema = z.object({
  /** A store uri of the attachment. It is data; the engine never follows it as an instruction (Bible 1, untrusted outputs). */
  uri: z.string().min(1),
  mediaType: z.string().min(1),
  note: nonBlankText(BRIEF_ATTACHMENT_NOTE_MAX).optional(),
});
export type BriefAttachment = z.infer<typeof briefAttachmentSchema>;

export const briefSchema = z.object({
  text: nonBlankText(BRIEF_TEXT_MAX),
  sources: z.array(briefSourceSchema).max(BRIEF_LIST_MAX),
  attachments: z.array(briefAttachmentSchema).max(BRIEF_LIST_MAX),
});
export type Brief = z.infer<typeof briefSchema>;

export const variantMatrixSchema = z.object({
  hooks: z.int().nonnegative().optional(),
  products: z.array(z.string().min(1)).optional(),
  personas: z.array(z.string().min(1)).optional(),
  languages: z.array(z.string().min(1)).optional(),
  captionStyles: z.array(z.string().min(1)).optional(),
  music: z.array(z.string().min(1)).optional(),
  maxVariants: z.int().nonnegative(),
  budgetUsd: usdSchema,
});
export type VariantMatrix = z.infer<typeof variantMatrixSchema>;

export const productionRequestSchema = z.object({
  schema: z.literal("meridian.production_request/v1"),
  requestId: idSchema("req_"),
  workspaceId: z.string().min(1),
  format: z.object({
    formatId: z.string().min(1),
    referenceVideo: z.string().min(1),
    videoDnaId: idSchema("dna_").optional(),
    keep: z.array(geneIdSchema),
    change: z.array(z.string().min(1)),
  }),
  /** The script the producer sends (the words to speak). Exactly one of `script` and `brief` is present (contract v8). */
  script: z
    .object({
      language: z.string().min(1),
      beats: z.array(scriptBeatSchema).min(1),
    })
    .optional(),
  /** The brief the engine writes its script from (contract v8). Exactly one of `script` and `brief` is present. */
  brief: briefSchema.optional(),
  visualRequests: z.array(
    z.object({
      beatId: z.string().min(1),
      want: z.string().min(1),
      strength: z.enum(["must", "may"]),
    }),
  ),
  product: z
    .object({
      sku: z.string().min(1),
      productKitId: z.string().min(1),
      claimIds: z.array(z.string().min(1)),
    })
    .optional(),
  page: z.object({
    pageId: z.string().min(1),
    styleKitId: z.string().min(1),
    personaId: z.string().min(1).optional(),
    voiceId: z.string().min(1),
    characterIds: z.array(z.string().min(1)).optional(),
  }),
  constraints: z.object({
    aspect: z.literal("9:16"),
    maxMs: positiveMsSchema,
    budgetUsd: usdSchema,
    deadline: z.iso.datetime().optional(),
    priority: z.enum(PRIORITIES),
  }),
  output: z.object({
    master: z.literal(true),
    variants: variantMatrixSchema.optional(),
  }),
}).superRefine((request, ctx) => {
  // Contract v8: a request names its words once. Both or neither is refused, and the issue's path names the field to fix.
  const hasScript = request.script !== undefined;
  const hasBrief = request.brief !== undefined;
  if (hasScript && hasBrief) {
    ctx.addIssue({
      code: "custom",
      path: ["brief"],
      message: "send either script or brief, not both: a script is the words to speak, a brief has the engine write them",
    });
  }
  if (!hasScript && !hasBrief) {
    ctx.addIssue({
      code: "custom",
      path: ["script"],
      message: "send a script, or a brief when the engine writes the script: neither is present",
    });
  }
});
export type ProductionRequest = z.infer<typeof productionRequestSchema>;

export const validatedRequestSchema = z
  .object({
    schema: z.literal("meridian.validated_request/v1"),
    requestId: idSchema("req_"),
    request: productionRequestSchema,
    kits: z.object({
      styleKit: kitRefSchema,
      persona: kitRefSchema.optional(),
      voiceId: z.string().min(1),
      characters: z.array(kitRefSchema),
      productKit: kitRefSchema.optional(),
    }),
    cachedVideoDnaId: idSchema("dna_").optional(),
    estimatedSpeechMs: z.int().nonnegative(),
  })
  .refine((value) => value.requestId === value.request.requestId, {
    message: "requestId must match request.requestId",
  });
export type ValidatedRequest = z.infer<typeof validatedRequestSchema>;

/** Intake's answer when a request is refused. Nothing is spent. */
export const intakeRejectionSchema = z.object({
  requestId: z.string().min(1),
  reasons: z.array(z.string().min(1)).min(1),
});
export type IntakeRejection = z.infer<typeof intakeRejectionSchema>;
