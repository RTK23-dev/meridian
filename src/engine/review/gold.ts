// Gold sets and the blocking rule (Bible 12.4). A check may block only after its gold set meets the accuracy target:
// recall on known failures at least 0.90, false-fail rate at most 0.10, on at least 200 labels (100 pass and 100 fail
// to start). Until then its failures route to review. Every number here is read from config/thresholds.ts.

import { z } from "zod";
import { thresholds } from "../config/thresholds.ts";
import { EngineError, type GateResult } from "../contracts/index.ts";

export const GOLD_LABEL_SCHEMA = "meridian.gold_label/v1";

/** The accuracy targets (12.4), from config. perClassToStart is half of examplesToStart: 100 pass and 100 fail. */
export const GOLD_TARGETS = {
  examplesToStart: thresholds.goldSets.examplesToStart,
  perClassToStart: thresholds.goldSets.examplesToStart / 2,
  recallMin: thresholds.goldSets.recallTargetOnFailures,
  falseFailMax: thresholds.goldSets.falseFailMax,
} as const;

/** A check key is "gate:rule", for example "plan:shots_tile_voice_duration". */
const CHECK_KEY = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

/**
 * One labelled example. shouldFail is the truth: a correct check fails this subject. input is what the check runs on;
 * the caller's predictFail function reads it. source says where the label came from (owner seed, or a review decision).
 */
export const goldLabelSchema = z.object({
  schema: z.literal(GOLD_LABEL_SCHEMA),
  labelId: z.string().min(1),
  check: z.string().regex(CHECK_KEY, { message: "check must be gate:rule" }),
  subjectId: z.string().min(1),
  shouldFail: z.boolean(),
  source: z.enum(["owner_seed", "human_review"]),
  reason: z.string().min(1),
  input: z.unknown(),
});
export type GoldLabel = z.infer<typeof goldLabelSchema>;

/** Validate a list of labels. Throws a typed EngineError that names the first bad label or duplicate id. */
export function parseGoldLabels(raw: unknown): GoldLabel[] {
  if (!Array.isArray(raw)) {
    throw new EngineError("invalid_input", "a gold set is a JSON array of labels");
  }
  const seen = new Set<string>();
  return raw.map((item: unknown, index: number) => {
    const parsed = goldLabelSchema.safeParse(item);
    if (!parsed.success) {
      throw new EngineError("invalid_input", `gold label ${index} is invalid: ${parsed.error.message}`);
    }
    if (seen.has(parsed.data.labelId)) {
      throw new EngineError("invalid_input", `gold label ${index} repeats labelId ${parsed.data.labelId}`);
    }
    seen.add(parsed.data.labelId);
    return parsed.data;
  });
}

/** Load a gold set from JSON text. A JSON syntax error is a typed invalid_input, never a silent empty set. */
export function loadGoldLabelsJson(text: string): GoldLabel[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EngineError("invalid_input", "gold set is not valid JSON", { cause: error });
  }
  return parseGoldLabels(raw);
}

export type GoldOutcome = {
  /** The truth for this label. */
  shouldFail: boolean;
  /** What the check returned on this label's input. */
  predictedFail: boolean;
};

export type GoldMetrics = {
  total: number;
  failLabels: number;
  passLabels: number;
  caughtFailures: number;
  falseFails: number;
  /** caughtFailures / failLabels, or null with no failing labels. */
  recall: number | null;
  /** falseFails / passLabels, or null with no passing labels. */
  falseFailRate: number | null;
  /** True when there are enough labels of both kinds to judge the check at all. */
  enoughLabels: boolean;
  /** True only when enoughLabels, recall at the target and false-fail rate at the limit. Only then may the check block. */
  meetsTarget: boolean;
};

const EPSILON = 1e-9;

/** Accuracy of one check from its outcomes. Pure. */
export function goldMetrics(outcomes: readonly GoldOutcome[]): GoldMetrics {
  let failLabels = 0;
  let passLabels = 0;
  let caughtFailures = 0;
  let falseFails = 0;
  for (const outcome of outcomes) {
    if (outcome.shouldFail) {
      failLabels++;
      if (outcome.predictedFail) {
        caughtFailures++;
      }
    } else {
      passLabels++;
      if (outcome.predictedFail) {
        falseFails++;
      }
    }
  }
  const recall = failLabels > 0 ? caughtFailures / failLabels : null;
  const falseFailRate = passLabels > 0 ? falseFails / passLabels : null;
  const enoughLabels =
    outcomes.length >= GOLD_TARGETS.examplesToStart &&
    failLabels >= GOLD_TARGETS.perClassToStart &&
    passLabels >= GOLD_TARGETS.perClassToStart;
  const meetsTarget =
    enoughLabels &&
    recall !== null &&
    recall + EPSILON >= GOLD_TARGETS.recallMin &&
    falseFailRate !== null &&
    falseFailRate <= GOLD_TARGETS.falseFailMax + EPSILON;
  return {
    total: outcomes.length,
    failLabels,
    passLabels,
    caughtFailures,
    falseFails,
    recall,
    falseFailRate,
    enoughLabels,
    meetsTarget,
  };
}

/** The metrics of one check: its labels, run through predictFail (the caller runs the check on label.input). */
export function goldMetricsForCheck(
  labels: readonly GoldLabel[],
  check: string,
  predictFail: (label: GoldLabel) => boolean,
): GoldMetrics {
  const outcomes = labels
    .filter((label) => label.check === check)
    .map((label) => ({ shouldFail: label.shouldFail, predictedFail: predictFail(label) }));
  return goldMetrics(outcomes);
}

/** The key a check is known by in gold sets and metrics maps. */
export function checkKey(gate: string, rule: string): string {
  return `${gate}:${rule}`;
}

export type GateVerdict = "pass" | "block" | "review";

export type GateDecision = {
  verdict: GateVerdict;
  /** Failing checks whose gold sets meet the target. They are the reason to block. */
  provenFailures: string[];
  /** Failing checks without a gold set that meets the target. They route to review. */
  unprovenFailures: string[];
};

/**
 * Route a gate result (5.3, 12.4). A pass proceeds. A failure blocks only when a failing check has a gold set that meets
 * the target; otherwise it goes to human review. A missing metrics entry counts as unproven, so missing evidence routes
 * to review and never blocks on a guess.
 */
export function decideGate(
  result: GateResult,
  metricsByCheck: Readonly<Record<string, GoldMetrics | undefined>>,
): GateDecision {
  if (result.pass) {
    return { verdict: "pass", provenFailures: [], unprovenFailures: [] };
  }
  const failing = result.checks.filter((item) => !item.pass).map((item) => checkKey(result.gate, item.rule));
  const provenFailures = failing.filter((key) => metricsByCheck[key]?.meetsTarget === true);
  const unprovenFailures = failing.filter((key) => !provenFailures.includes(key));
  return {
    verdict: provenFailures.length > 0 ? "block" : "review",
    provenFailures,
    unprovenFailures,
  };
}
