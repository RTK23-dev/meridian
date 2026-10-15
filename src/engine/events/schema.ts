// The learning events the engine writes (Video Engine Bible 16.1), as zod schemas. Every event has a kind, the stage and subject
// it is about, a dedupe key (the same event written twice is stored once) and a body. The body is validated before it is
// stored, so the stream holds only what the contracts say. Free text from a model is never a body field: a check's detail is
// dropped here, and only rule names, scores and numbers are kept (Bible 1, trust boundaries).

import { z } from "zod";
import {
  claudeRoleSchema,
  costBreakdownSchema,
  decisionSchema,
  gateResultSchema,
  idSchema,
  takeCheckSchema,
  usdSchema,
  visualTypeSchema,
} from "../contracts/index.ts";

export const EVENT_KINDS = [
  "plan.decided",
  "take.checked",
  "shot.downgraded",
  "review.decided",
  "gate.result",
  "video.delivered",
  "cost.reconciled",
  "request.delivered",
  "variant.delivered",
  "variant.planned",
] as const;

export const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

/** The status of one variant in a variants run: built now, deferred to generation, not built, or skipped by the fit. */
export const VARIANT_PLAN_STATUSES = ["built", "deferred", "not_built", "skipped"] as const;

const ruleName = z.string().min(1).max(120);

const planDecidedBody = z.object({
  planId: z.string().min(1),
  decisions: z.array(decisionSchema),
});

const takeCheckedBody = z.object({
  takeId: idSchema("take_"),
  shotId: idSchema("shot_"),
  visualType: visualTypeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The Critic's prompt version, when the check was a Claude call. Null for a code-only check. */
  promptVersion: z.string().regex(/^[a-z][a-z0-9_]*@[1-9][0-9]*$/).nullable(),
  pass: z.boolean(),
  confidence: z.number().min(0).max(1),
  action: z.enum(["accept", "redo", "downgrade", "escalate"]),
  /** Rule names, scores and frame times only. The check's free-text detail is never stored here. */
  checks: z.array(takeCheckSchema.omit({ detail: true })),
});

const shotDowngradedBody = z.object({
  shotId: idSchema("shot_"),
  fromType: visualTypeSchema,
  toType: visualTypeSchema,
  reasons: z.array(ruleName).min(1),
});

const reviewDecidedBody = z.object({
  reviewItemId: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  choice: z.string().min(1),
  reason: z.string().min(1),
});

const videoDeliveredBody = z.object({
  manifestId: idSchema("vid_"),
  requestId: idSchema("req_"),
  edlId: idSchema("edl_"),
  /** The master's video id for a variant, null for the master. */
  variantOf: idSchema("vid_").nullable(),
  cost: costBreakdownSchema,
  timings: z.record(z.string(), z.int().nonnegative()),
  /** The version of each configuration module the video was made with (Bible 16.3). */
  configVersions: z.record(z.string(), z.string().min(1)),
});

const costReconciledBody = z.object({
  entryId: idSchema("led_"),
  requestId: idSchema("req_"),
  stage: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  role: claudeRoleSchema.nullable(),
  estimateUsd: usdSchema,
  reservedUsd: usdSchema,
  actualUsd: usdSchema,
  /** True when the actual is a list-price fallback or the held amount, not the provider's bill (Bible 14.1 step 4). */
  actualIsEstimate: z.boolean(),
  /** The video the call is attributed to, or null when it belongs to the request as a whole. */
  videoId: idSchema("vid_").nullable(),
});

const requestDeliveredBody = z.object({
  requestId: idSchema("req_"),
  reservationId: idSchema("res_"),
  masterVideoId: idSchema("vid_"),
  deliveredVariantVideoIds: z.array(idSchema("vid_")),
  /** Variant EDLs that were built but did not deliver (their review failed or they escalated). */
  undeliveredVariantEdlIds: z.array(idSchema("edl_")),
  costTotalUsd: usdSchema,
  /** Claude calls that never returned an answer. Their cost is held as the estimate. */
  unansweredCalls: z.int().nonnegative(),
  releasedUsd: usdSchema,
});

const variantDeliveredBody = z.object({
  videoId: idSchema("vid_"),
  edlId: idSchema("edl_"),
  variantOf: idSchema("vid_"),
  /** The attribute the variant changes, when the EDL alone shows it (caption or music). Null when it does not (unknown stays null). */
  attribute: z.string().min(1).nullable(),
  /** The value of that attribute (a caption band), or null when it is not known from the EDL. */
  value: z.string().min(1).nullable(),
  cost: costBreakdownSchema,
});

const variantPlannedBody = z.object({
  key: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string().min(1),
  controlEdlId: idSchema("edl_"),
  status: z.enum(VARIANT_PLAN_STATUSES),
  reason: z.string().min(1).nullable(),
  estimateUsd: usdSchema,
  work: z.object({
    produceShotIds: z.array(idSchema("shot_")),
    voiceBeatIds: z.array(z.string().min(1)),
    writerBeatIds: z.array(z.string().min(1)),
  }),
});

/** One learning event: its kind, what it is about, its dedupe key and its body. */
export const learningEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan.decided"), stage: z.literal("plan"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: planDecidedBody }),
  z.object({ kind: z.literal("take.checked"), stage: z.literal("check_take"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: takeCheckedBody }),
  z.object({ kind: z.literal("shot.downgraded"), stage: z.literal("plan"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: shotDowngradedBody }),
  z.object({ kind: z.literal("review.decided"), stage: z.literal("review"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: reviewDecidedBody }),
  z.object({ kind: z.literal("gate.result"), stage: z.string().min(1), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: gateResultSchema }),
  z.object({ kind: z.literal("video.delivered"), stage: z.literal("deliver"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: videoDeliveredBody }),
  z.object({ kind: z.literal("cost.reconciled"), stage: z.literal("deliver"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: costReconciledBody }),
  z.object({ kind: z.literal("request.delivered"), stage: z.literal("deliver"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: requestDeliveredBody }),
  z.object({ kind: z.literal("variant.delivered"), stage: z.literal("deliver"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: variantDeliveredBody }),
  z.object({ kind: z.literal("variant.planned"), stage: z.literal("variants"), subjectId: z.string().min(1), dedupeKey: z.string().min(1), body: variantPlannedBody }),
]);

export type LearningEvent = z.infer<typeof learningEventSchema>;
export type LearningEventBody<K extends EventKind> = Extract<LearningEvent, { kind: K }>["body"];
