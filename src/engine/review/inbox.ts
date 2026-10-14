// The review item for a take escalation (Bible 5.3, 12.5): the payload Meridian's review inbox shows and stores. Building the
// item is pure and validated here; writing it into engine_review_items (detail) and showing it in the inbox is the lead's wiring.
// The item lists every take of the shot with its checks, so a reviewer can accept, choose another take, change the visual type,
// edit the prompt or reject. Only rule names and code-written details appear here, never model prose (CLAUDE.md rule 8).

import { z } from "zod";
import { EngineError } from "../contracts/errors.ts";
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
