// The review item for a take escalation (Bible 5.3, 12.5): the payload Meridian's review inbox shows and stores. Building the
// item is pure and validated here; writing it into engine_review_items (detail) and showing it in the inbox is the lead's wiring.
// The item lists every take of the shot with its checks, so a reviewer can accept, choose another take, change the visual type,
// edit the prompt or reject. Only rule names and code-written details appear here, never model prose (CLAUDE.md rule 8).

import { z } from "zod";
import { EngineError } from "../contracts/errors.ts";
import { edlLayerSchema } from "../contracts/edl.ts";
import { idSchema } from "../contracts/ids.ts";
import { visualTypeSchema } from "../contracts/plan.ts";
import { TAKE_ACTIONS, takeVerdictSchema, type TakeVerdict } from "../contracts/take.ts";

export const TAKE_REVIEW_SCHEMA = "meridian.take_review/v1";

/** The buttons a reviewer has (Bible 12.5). */
export const TAKE_REVIEW_ACTIONS = ["accept", "choose_take", "change_visual_type", "edit_prompt", "reject"] as const;
export type TakeReviewAction = (typeof TAKE_REVIEW_ACTIONS)[number];

const reviewCheckSchema = z.object({
  rule: z.string().min(1),
  pass: z.boolean(),
  score: z.number().finite().optional(),
  detail: z.string().min(1).optional(),
});

const reviewTakeSchema = z.object({
  takeId: idSchema("take_"),
  /** The Take artifact's id, or null when it was not stored. */
  takeArtifactId: z.string().min(1).nullable(),
  /** The verdict artifact's id, or null when it was not stored. */
  verdictArtifactId: z.string().min(1).nullable(),
  pass: z.boolean(),
  action: z.enum(TAKE_ACTIONS),
  confidence: z.number().min(0).max(1),
  /** Rule names of the failing checks, sorted and unique. These are the hints a redo would have carried. */
  failing: z.array(z.string().min(1)),
  checks: z.array(reviewCheckSchema).min(1),
});

export const takeReviewItemSchema = z.object({
  schema: z.literal(TAKE_REVIEW_SCHEMA),
  kind: z.literal("escalation"),
  requestId: idSchema("req_"),
  shotId: idSchema("shot_"),
  visualType: visualTypeSchema,
  /** Why the shot went to a human, built from rule names and the route (never model text). */
  reason: z.string().min(1),
  /** The plan artifact's id, or null when it was not stored. */
  planArtifactId: z.string().min(1).nullable(),
  takes: z.array(reviewTakeSchema).min(1),
  actions: z.array(z.enum(TAKE_REVIEW_ACTIONS)).length(TAKE_REVIEW_ACTIONS.length),
});
export type TakeReviewItem = z.infer<typeof takeReviewItemSchema>;

export type TakeReviewInput = {
  requestId: string;
  shotId: string;
  visualType: string;
  reason: string;
  planArtifactId: string | null;
  takes: Array<{
    takeId: string;
    takeArtifactId: string | null;
    verdictArtifactId: string | null;
    verdict: TakeVerdict;
  }>;
};

/** The review item of one escalated shot. Throws invalid_input when a value does not match its contract. */
export function takeReviewItem(input: TakeReviewInput): TakeReviewItem {
  const item = {
    schema: TAKE_REVIEW_SCHEMA,
    kind: "escalation" as const,
    requestId: input.requestId,
    shotId: input.shotId,
    visualType: input.visualType,
    reason: input.reason,
    planArtifactId: input.planArtifactId,
    takes: input.takes.map((take) => {
      const verdict = takeVerdictSchema.parse(take.verdict);
      return {
        takeId: take.takeId,
        takeArtifactId: take.takeArtifactId,
        verdictArtifactId: take.verdictArtifactId,
        pass: verdict.pass,
        action: verdict.action,
        confidence: verdict.confidence,
        failing: [...new Set(verdict.checks.filter((check) => !check.pass).map((check) => check.rule))].sort(),
        checks: verdict.checks.map((check) => ({
          rule: check.rule,
          pass: check.pass,
          ...(check.score === undefined ? {} : { score: check.score }),
          ...(check.detail === undefined ? {} : { detail: check.detail }),
        })),
      };
    }),
    actions: [...TAKE_REVIEW_ACTIONS],
  };
  const parsed = takeReviewItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the take review item does not match its contract: ${parsed.error.message}`, {
      stage: "check_take",
    });
  }
  return parsed.data;
}

export const GATE_REVIEW_SCHEMA = "meridian.gate_review/v1";

/** The buttons a reviewer has on a gate escalation: accept the subject as it is, or reject it (Bible 12.5). */
export const GATE_REVIEW_ACTIONS = ["accept", "reject"] as const;
export type GateReviewAction = (typeof GATE_REVIEW_ACTIONS)[number];

const gateReviewCheckSchema = z.object({
  rule: z.string().min(1),
  pass: z.boolean(),
  value: z.number().finite().optional(),
  limit: z.number().finite().optional(),
  detail: z.string().min(1).optional(),
});

const gateReviewFailureSchema = z.object({
  rule: z.string().min(1),
  shotId: idSchema("shot_").optional(),
  layer: edlLayerSchema.optional(),
});

/**
 * The review item of a pre_render or post_render escalation (Bible 5.3, 12.5): the gate, its subject, every check with its evidence,
 * and the failures with the shot or layer at fault. The reason is built from rule names, never from model text (CLAUDE.md rule 8).
 */
export const gateReviewItemSchema = z.object({
  schema: z.literal(GATE_REVIEW_SCHEMA),
  kind: z.literal("escalation"),
  requestId: idSchema("req_"),
  gate: z.enum(["pre_render", "post_render"]),
  /** The EDL id for pre_render, the video id for post_render. */
  subjectId: z.string().min(1),
  reason: z.string().min(1),
  /** The artifact the gate result was stored under (gate_result or review_result), or null when it was not stored. */
  resultArtifactId: z.string().min(1).nullable(),
  checks: z.array(gateReviewCheckSchema).min(1),
  failing: z.array(z.string().min(1)),
  failures: z.array(gateReviewFailureSchema),
  failingShotIds: z.array(idSchema("shot_")),
  actions: z.array(z.enum(GATE_REVIEW_ACTIONS)).length(GATE_REVIEW_ACTIONS.length),
});
export type GateReviewItem = z.infer<typeof gateReviewItemSchema>;

export type GateReviewInput = {
  requestId: string;
  /** The gate's result. Its gate must be pre_render or post_render. */
  gate: { gate: string; subjectId: string; checks: ReadonlyArray<{ rule: string; pass: boolean; value?: number; limit?: number; detail?: string }>; failingShotIds?: string[] };
  resultArtifactId: string | null;
  failures: ReadonlyArray<{ rule: string; shotId?: string; layer?: string }>;
};

/** The review item of a gate escalation. Throws invalid_input when the gate is not a render gate or a value does not match its contract. */
export function gateReviewItem(input: GateReviewInput): GateReviewItem {
  if (input.gate.gate !== "pre_render" && input.gate.gate !== "post_render") {
    throw new EngineError("invalid_input", `a gate review item is for pre_render or post_render, not ${input.gate.gate}`, { stage: input.gate.gate });
  }
  const failing = [...new Set(input.gate.checks.filter((check) => !check.pass).map((check) => check.rule))].sort();
  const item = {
    schema: GATE_REVIEW_SCHEMA,
    kind: "escalation" as const,
    requestId: input.requestId,
    gate: input.gate.gate,
    subjectId: input.gate.subjectId,
    reason: `${input.gate.gate} failed without a proven gold set: ${failing.join(", ") || "no failing check"}`,
    resultArtifactId: input.resultArtifactId,
    checks: input.gate.checks.map((check) => ({
      rule: check.rule,
      pass: check.pass,
      ...(check.value === undefined ? {} : { value: check.value }),
      ...(check.limit === undefined ? {} : { limit: check.limit }),
      ...(check.detail === undefined ? {} : { detail: check.detail }),
    })),
    failing,
    failures: input.failures.map((failure) => ({
      rule: failure.rule,
      ...(failure.shotId === undefined ? {} : { shotId: failure.shotId }),
      ...(failure.layer === undefined ? {} : { layer: failure.layer }),
    })),
    failingShotIds: [...new Set(input.gate.failingShotIds ?? [])],
    actions: [...GATE_REVIEW_ACTIONS],
  };
  const parsed = gateReviewItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the gate review item does not match its contract: ${parsed.error.message}`, { stage: input.gate.gate });
  }
  return parsed.data;
}
