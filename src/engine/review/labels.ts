// Review decisions as gold-set labels (Bible 12.4, 12.5). A human decision on an inbox item is a labelled example of the checks the item
// showed, in the gold-set format (gold.ts, meridian.gold_label/v1), and the loaders read it back (take/gold.ts, loadCriticFinalGold).
// Pure: the item and the decision are data, and no store is written here (the inbox wiring is the lead's).
//
// The rule for each label, so no label is a guess:
// - accept (of one take, or of the video): every check whose input the item carries should not fail, so each gets shouldFail false.
// - reject: only a check that failed is labelled shouldFail true. A passing check on a rejected item is not labelled, because the
//   reviewer did not say which check should have failed.
// - choose_take: the chosen take is accepted, and the other takes give no label (choosing one does not reject the others).
// - change_visual_type and edit_prompt change the plan, not a take's checks, so they label nothing.
// A check the item does not carry the input for is listed in `skipped` with its reason, never labelled from a guess.

import { z } from "zod";
import { thresholds } from "../config/thresholds.ts";
import { EngineError } from "../contracts/errors.ts";
import { idSchema } from "../contracts/ids.ts";
import { FINAL_RUBRIC_ITEMS, finalRubricSchema } from "../claude/roles/critic_final.ts";
import { SLOP_RUBRIC_ITEMS } from "../claude/roles/critic_take.ts";
import { goldLabelSchema, goldMetricsForCheck, loadGoldLabelsJson, type GoldLabel, type GoldMetrics } from "./gold.ts";
import { gateReviewItemSchema, takeReviewItemSchema, type TakeReviewItem } from "./inbox.ts";
import { CRITIC_FINAL_GOLD_KEY } from "./gates/postRender.ts";

export const LABEL_SCHEMA = "meridian.gold_label/v1";
export const REVIEW_DECISION_ACTIONS = ["accept", "choose_take", "reject", "change_visual_type", "edit_prompt"] as const;

/** A reviewer's decision, with the reason it is recorded for (Bible 12.5: every decision is a label with the reviewer's reason). */
export const reviewDecisionSchema = z.object({
  action: z.enum(REVIEW_DECISION_ACTIONS),
  /** The take the reviewer accepted or chose. Required for accept and choose_take. */
  takeId: idSchema("take_").optional(),
  reason: z.string().trim().min(1),
});
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export type SkippedCheck = { subject: string; check: string; reason: string };
export type LabelOutcome = { labels: GoldLabel[]; skipped: SkippedCheck[] };

/** The similarity checks of a take and their gold sets (take/types.ts TAKE_GOLD_KEYS). */
const SIMILARITY_GOLD: Readonly<Record<string, "take:product_match" | "take:persona_match" | "take:palette_match">> = {
  product_match: "take:product_match",
  persona_match: "take:persona_match",
  palette_match: "take:palette_match",
};

/** The checks that never get a label from a decision: the Critic's confidence has no gold set, and an unanswered Critic has no score. */
const UNLABELLED_RULES = new Set(["critic_confidence", "rubric_answered"]);

/** The input of the final Critic's gold label: the nine rubric scores, as the Critic answered them. */
export const criticFinalGoldInputSchema = z.object({ rubric: finalRubricSchema });

/** The gate's own rule on one label of the final Critic: true when any rubric item is below the floor (Bible 12.2, 12.3). */
export function predictCriticFinalFail(input: unknown): boolean {
  const parsed = criticFinalGoldInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new EngineError("invalid_input", "the input of a post_render:critic_final label does not match its check", { stage: "post_render" });
  }
  const floor = thresholds.take.slopRubricItemMin.value;
  return Object.values(parsed.data.rubric).some((score) => score < floor);
}

/**
 * Load the final Critic's gold set from JSON. Every label must name post_render:critic_final and carry the nine scores. The metrics
 * are recomputed with the gate's rule. Nothing is loaded in part: one bad label refuses the set.
 */
export function loadCriticFinalGold(text: string): { labels: GoldLabel[]; metrics: GoldMetrics } {
  const labels = loadGoldLabelsJson(text);
  for (const label of labels) {
    if (label.check !== CRITIC_FINAL_GOLD_KEY) {
      throw new EngineError("invalid_input", `gold label ${label.labelId} names ${label.check}, not ${CRITIC_FINAL_GOLD_KEY}`, { stage: "post_render" });
    }
    if (!criticFinalGoldInputSchema.safeParse(label.input).success) {
      throw new EngineError("invalid_input", `gold label ${label.labelId} has an input that does not match the final Critic`, { stage: "post_render" });
    }
  }
  return {
    labels,
    metrics: goldMetricsForCheck(labels, CRITIC_FINAL_GOLD_KEY, (label) => predictCriticFinalFail(label.input)),
  };
}

function label(fields: { labelId: string; check: string; subjectId: string; shouldFail: boolean; reason: string; input: unknown }): GoldLabel {
  return goldLabelSchema.parse({ schema: LABEL_SCHEMA, source: "human_review", ...fields });
}

function parseDecision(decision: unknown, stage: string): ReviewDecision {
  const parsed = reviewDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the review decision is not valid: ${parsed.error.issues[0]?.message ?? "invalid"}`, { stage });
  }
  return parsed.data;
}

/** The labels of one decision on a take review item (Bible 12.5). Throws invalid_input for a decision the item cannot take. */
export function labelsFromTakeDecision(itemInput: unknown, decisionInput: unknown): LabelOutcome {
  const parsedItem = takeReviewItemSchema.safeParse(itemInput);
  if (!parsedItem.success) throw new EngineError("invalid_input", "the take review item does not parse", { stage: "check_take" });
  const item: TakeReviewItem = parsedItem.data;
  const decision = parseDecision(decisionInput, "check_take");

  if (decision.action === "change_visual_type" || decision.action === "edit_prompt") {
    return {
      labels: [],
      skipped: [{ subject: item.shotId, check: "*", reason: "the decision changes the plan, not the checks of a take, so it labels nothing" }],
    };
  }

  const accepted = decision.action === "accept" || decision.action === "choose_take" ? decision.takeId : undefined;
  if ((decision.action === "accept" || decision.action === "choose_take") && accepted === undefined) {
    throw new EngineError("invalid_input", `a ${decision.action} needs the take it accepts`, { stage: "check_take" });
  }
  if (accepted !== undefined && !item.takes.some((take) => take.takeId === accepted)) {
    throw new EngineError("invalid_input", `take ${accepted} is not in the review item`, { stage: "check_take" });
  }

  const labels: GoldLabel[] = [];
  const skipped: SkippedCheck[] = [];
  const rejecting = decision.action === "reject";
  const floor = thresholds.take.slopRubricItemMin.value;

  for (const take of item.takes) {
    const isAccepted = accepted === take.takeId;
    if (!isAccepted && !rejecting) continue;
    const shouldFailFor = (failed: boolean): boolean | null => (isAccepted ? false : failed ? true : null);

    // The slop rubric: one label per take, with all seven scores as the Critic gave them.
    const rubric = Object.fromEntries(SLOP_RUBRIC_ITEMS.map((rule) => [rule, take.checks.find((check) => check.rule === `rubric_${rule}`)?.score]));
    const scored = SLOP_RUBRIC_ITEMS.every((rule) => typeof rubric[rule] === "number");
    if (!scored) {
      skipped.push({ subject: take.takeId, check: "take:slop_rubric", reason: "the Critic's rubric scores are not in the review item" });
    } else {
      const failed = SLOP_RUBRIC_ITEMS.some((rule) => (rubric[rule] as number) < floor);
      const shouldFail = shouldFailFor(failed);
      if (shouldFail !== null) {
        labels.push(
          label({
            labelId: `review:${item.requestId}:${take.takeId}:take:slop_rubric:${decision.action}`,
            check: "take:slop_rubric",
            subjectId: take.takeId,
            shouldFail,
            reason: decision.reason,
            input: { rubric },
          }),
        );
      }
    }

    for (const check of take.checks) {
      const similarity = SIMILARITY_GOLD[check.rule];
      if (similarity !== undefined) {
        if (check.score === undefined) {
          if (isAccepted || !check.pass) {
            skipped.push({ subject: take.takeId, check: similarity, reason: "the review item carries no similarity score for this check" });
          }
          continue;
        }
        const shouldFail = shouldFailFor(!check.pass);
        if (shouldFail !== null) {
          labels.push(
            label({
              labelId: `review:${item.requestId}:${take.takeId}:${similarity}:${decision.action}`,
              check: similarity,
              subjectId: take.takeId,
              shouldFail,
              reason: decision.reason,
              input: { score: check.score },
            }),
          );
        }
        continue;
      }
      if (check.rule.startsWith("rubric_") || UNLABELLED_RULES.has(check.rule)) continue;
      if (isAccepted || !check.pass) {
        skipped.push({ subject: take.takeId, check: check.rule, reason: "the review item carries no measurements for this check, so it is not labelled" });
      }
    }
  }
  return { labels: labels.map((item) => goldLabelSchema.parse(item)), skipped };
}

/** The labels of one decision on a pre_render or post_render escalation. Only the final Critic has a gold input the item carries. */
export function labelsFromGateDecision(itemInput: unknown, decisionInput: unknown): LabelOutcome {
  const parsedItem = gateReviewItemSchema.safeParse(itemInput);
  if (!parsedItem.success) throw new EngineError("invalid_input", "the gate review item does not parse", { stage: "post_render" });
  const item = parsedItem.data;
  const decision = parseDecision(decisionInput, item.gate);
  if (decision.action !== "accept" && decision.action !== "reject") {
    throw new EngineError("invalid_input", `a ${item.gate} escalation offers accept and reject, not ${decision.action}`, { stage: item.gate });
  }

  const labels: GoldLabel[] = [];
  const skipped: SkippedCheck[] = [];
  if (item.gate === "pre_render") {
    for (const check of item.checks) {
      if (decision.action === "accept" || !check.pass) {
        skipped.push({ subject: item.subjectId, check: check.rule, reason: "a pre_render check has no gold input in the review item, so it is not labelled" });
      }
    }
    return { labels, skipped };
  }

  const rubric = Object.fromEntries(FINAL_RUBRIC_ITEMS.map((rule) => [rule, item.checks.find((check) => check.rule === `rubric_${rule}`)?.value]));
  if (!FINAL_RUBRIC_ITEMS.every((rule) => typeof rubric[rule] === "number")) {
    skipped.push({ subject: item.subjectId, check: CRITIC_FINAL_GOLD_KEY, reason: "the final Critic's rubric scores are not in the review item" });
    return { labels, skipped };
  }
  const floor = thresholds.take.slopRubricItemMin.value;
  const failed = FINAL_RUBRIC_ITEMS.some((rule) => (rubric[rule] as number) < floor);
  if (decision.action === "reject" && !failed) {
    skipped.push({ subject: item.subjectId, check: CRITIC_FINAL_GOLD_KEY, reason: "the rubric passed and a rejection does not say which item should have failed" });
    return { labels, skipped };
  }
  labels.push(
    label({
      labelId: `review:${item.requestId}:${item.subjectId}:${CRITIC_FINAL_GOLD_KEY}:${decision.action}`,
      check: CRITIC_FINAL_GOLD_KEY,
      subjectId: item.subjectId,
      shouldFail: decision.action === "reject",
      reason: decision.reason,
      input: { rubric },
    }),
  );
  return { labels, skipped };
}
