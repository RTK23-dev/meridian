/**
 * Pure model for the diagnostic weights. A share is a weight divided by the total of all weights. It is shown only as a
 * preview of the saved arithmetic. It does not claim that a weight changes which opportunity wins.
 */
// Relative, not "@/": the node test runner does not resolve the alias, and this module is loaded by tests.
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, type ScoreWeights } from "../../lib/meridian/scoring.ts";

export type WeightKey = keyof ScoreWeights;

export const WEIGHT_LABELS: Record<WeightKey, string> = {
  brandFit: "Brand fit",
  historicalEvidence: "Historical evidence",
  marketSignal: "Market signal",
  novelty: "Novelty",
  reproducibility: "Reproducibility",
  saturation: "Saturation (penalty)",
  risk: "Risk (penalty)",
};

/** The server accepts 0 to 5 with decimals. The slider uses the same bounds, so a slider value is always accepted. */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 5;
export const WEIGHT_STEP = 0.05;

const PENALTIES: ReadonlySet<WeightKey> = new Set<WeightKey>(["saturation", "risk"]);

export function isPenalty(key: WeightKey): boolean {
  return PENALTIES.has(key);
}

/** Parses the text a person typed. Blank text, letters, and values outside 0 to 5 are rejected, not read as zero. */
export function parseWeightText(text: string): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { ok: false, reason: "Enter a number from 0 to 5." };
  const value = Number(trimmed);
  if (value < WEIGHT_MIN || value > WEIGHT_MAX) return { ok: false, reason: "Enter a number from 0 to 5." };
  return { ok: true, value };
}

export function weightShares(weights: ScoreWeights): Array<{ key: WeightKey; label: string; value: number; share: number; penalty: boolean }> {
  const total = WEIGHT_KEYS.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  return WEIGHT_KEYS.map((key) => ({
    key,
    label: WEIGHT_LABELS[key],
    value: weights[key],
    share: total > 0 ? Math.max(0, weights[key]) / total : 0,
    penalty: isPenalty(key),
  }));
}

export function sameWeights(left: ScoreWeights, right: ScoreWeights): boolean {
  return WEIGHT_KEYS.every((key) => left[key] === right[key]);
}

export function defaultWeights(): ScoreWeights {
  return { ...DEFAULT_WEIGHTS };
}

/** Rounds a slider value to the step so that the text box and the slider always show the same number. */
export function roundToStep(value: number): number {
  return Number((Math.round(value / WEIGHT_STEP) * WEIGHT_STEP).toFixed(2));
}
