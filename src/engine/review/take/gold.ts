// The gold-set loader for take checks (Bible 12.4). A gold set is a JSON array of meridian.gold_label/v1 labels (gold.ts).
// Each label names one take check and carries the input that check runs on, so its prediction is recomputed here with the
// same rule the gate uses. Metrics are then the recall and false-fail rate of that rule on the labels. Until a set meets the
// target (200 labels, 100 failing and 100 passing, recall at least 0.90, false-fail at most 0.10) the check cannot block.
// The bundled fixture is an authored sample for the loader's tests, not an owner label.

import { z } from "zod";
import { thresholds } from "../../config/thresholds.ts";
import { EngineError } from "../../contracts/errors.ts";
import { positiveMsSchema } from "../../contracts/primitives.ts";
import { slopRubricItemsSchema } from "../../claude/roles/critic_take.ts";
import { goldMetricsForCheck, loadGoldLabelsJson, type GoldLabel, type GoldMetrics } from "../gold.ts";
import { codeRows } from "./code.ts";
import { TAKE_GOLD_KEYS, isTakeGoldKey, type TakeGoldKey } from "./types.ts";

const unitScore = z.number().min(0).max(1);

/** A code check's input: the shot's facts and the take's measurements, exactly as the gate's code rows read them. */
const codeInputSchema = z.object({
  shot: z.object({ plannedDurationMs: positiveMsSchema, motionRequired: z.boolean() }),
  measurements: z.unknown(),
});

/** A similarity check's input: the score the scorer returned. */
const similarityInputSchema = z.object({ score: unitScore });

/** The slop rubric's input: the seven item scores, as the Critic answered them. */
const rubricInputSchema = z.object({ rubric: slopRubricItemsSchema });

/** The input schema of a gold key. */
export function goldInputSchema(key: TakeGoldKey): z.ZodType {
  if (key === "take:slop_rubric") return rubricInputSchema;
  if (key === "take:product_match" || key === "take:persona_match" || key === "take:palette_match") {
    return similarityInputSchema;
  }
  return codeInputSchema;
}

/** The score floor of a similarity gold key, from configuration. */
function similarityFloor(key: TakeGoldKey): number {
  if (key === "take:product_match") return thresholds.take.productMatchMin.value;
  if (key === "take:persona_match") return thresholds.take.personaMatchMin.value;
  return thresholds.take.paletteShareMin.value;
}

/**
 * The gate's own rule applied to one label's input: true when the check would fail that input. A code check runs the same rows
 * as the gate, so a missing measurement predicts a failure. A similarity check fails below its floor. The rubric fails when any
 * item is below its floor.
 */
export function predictTakeFail(key: TakeGoldKey, input: unknown): boolean {
  const parsed = goldInputSchema(key).safeParse(input);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the input of a ${key} label does not match its check`, { stage: "check_take" });
  }
  if (key === "take:slop_rubric") {
    const floor = thresholds.take.slopRubricItemMin.value;
    const rubric = rubricInputSchema.parse(parsed.data).rubric;
    return Object.values(rubric).some((score) => score < floor);
  }
  if (key === "take:product_match" || key === "take:persona_match" || key === "take:palette_match") {
    return similarityInputSchema.parse(parsed.data).score < similarityFloor(key);
  }
  const data = codeInputSchema.parse(parsed.data);
  const row = codeRows(data.shot, data.measurements).find((item) => item.gold === key);
  return row !== undefined && !row.check.pass;
}

/** The metrics of every take gold key from a set of labels. A key with no labels has enoughLabels false and cannot block. */
export function takeGoldMetrics(labels: readonly GoldLabel[]): Record<TakeGoldKey, GoldMetrics> {
  const metrics = {} as Record<TakeGoldKey, GoldMetrics>;
  for (const key of TAKE_GOLD_KEYS) {
    metrics[key] = goldMetricsForCheck(labels, key, (label) => predictTakeFail(key, label.input));
  }
  return metrics;
}

export type TakeGoldSet = {
  labels: GoldLabel[];
  metrics: Record<TakeGoldKey, GoldMetrics>;
};

/**
 * Load a take gold set from JSON text. A label that names a check that is not a take check, or whose input does not match that
 * check, is an invalid_input that names the label. Nothing is loaded in part.
 */
export function loadTakeGold(text: string): TakeGoldSet {
  const labels = loadGoldLabelsJson(text);
  for (const label of labels) {
    if (!isTakeGoldKey(label.check)) {
      throw new EngineError("invalid_input", `gold label ${label.labelId} names ${label.check}, which is not a take check`, {
        stage: "check_take",
      });
    }
    if (!goldInputSchema(label.check).safeParse(label.input).success) {
      throw new EngineError("invalid_input", `gold label ${label.labelId} has an input that does not match ${label.check}`, {
        stage: "check_take",
      });
    }
  }
  return { labels, metrics: takeGoldMetrics(labels) };
}
