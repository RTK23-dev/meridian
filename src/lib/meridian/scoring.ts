/** Configurable weights. Business rules live here, not in a prompt. */
export type ScoreWeights = {
  brandFit: number;
  historicalEvidence: number;
  marketSignal: number;
  novelty: number;
  reproducibility: number;
  saturation: number;
  risk: number;
};

/** Each input is clamped to 0–1. Evidence is supplied by the caller. */
export type ScoreInputs = ScoreWeights;

export const DEFAULT_WEIGHTS: ScoreWeights = {
  brandFit: 0.25,
  historicalEvidence: 0.2,
  marketSignal: 0.15,
  novelty: 0.15,
  reproducibility: 0.1,
  saturation: 0.1,
  risk: 0.15,
};

export const WEIGHT_KEYS = [
  "brandFit",
  "historicalEvidence",
  "marketSignal",
  "novelty",
  "reproducibility",
  "saturation",
  "risk",
] as const satisfies readonly (keyof ScoreWeights)[];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 5) return 5;
  return Math.round(value * 1000) / 1000;
}

/** Rejects blank and non-numeric text. An empty string is not zero. */
export function parseWeight(value: unknown, label: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!text || text === "undefined" || text === "NaN") {
    throw new Error(`${label} must be a number from 0 to 5.`);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label} must be a number from 0 to 5.`);
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 5) {
    throw new Error(`${label} must be a number from 0 to 5.`);
  }
  return number;
}

/** Whole counts. A blank required field is not zero. A blank optional field is zero. */
export function parseCount(value: unknown, label: string, optional = false): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (optional) return 0;
    throw new Error(`${label} must be a whole number.`);
  }
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a whole number.`);
  const number = Number(text);
  if (!Number.isInteger(number) || number < 0 || number > 1_000_000_000) {
    throw new Error(`${label} must be a whole number.`);
  }
  return number;
}

export function weightsFromUnknown(row: Record<string, unknown> | undefined): ScoreWeights {
  if (!row) return { ...DEFAULT_WEIGHTS };
  const next = { ...DEFAULT_WEIGHTS };
  const columns: Record<keyof ScoreWeights, string> = {
    brandFit: "brand_fit",
    historicalEvidence: "historical_evidence",
    marketSignal: "market_signal",
    novelty: "novelty",
    reproducibility: "reproducibility",
    saturation: "saturation",
    risk: "risk",
  };
  for (const key of WEIGHT_KEYS) {
    const value = Number(row[columns[key]]);
    if (Number.isFinite(value)) next[key] = value;
  }
  return next;
}

/**
 * Transparent opportunity score.
 * Positive terms add support. Saturation and risk subtract.
 * `normalized` maps the weighted result onto 0–1 for ranking.
 * `raw` is the unscaled weighted sum so the arithmetic stays inspectable.
 */
export function opportunityScore(
  inputs: ScoreInputs,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): { raw: number; normalized: number } {
  const raw =
    weights.brandFit * clamp01(inputs.brandFit) +
    weights.historicalEvidence * clamp01(inputs.historicalEvidence) +
    weights.marketSignal * clamp01(inputs.marketSignal) +
    weights.novelty * clamp01(inputs.novelty) +
    weights.reproducibility * clamp01(inputs.reproducibility) -
    weights.saturation * clamp01(inputs.saturation) -
    weights.risk * clamp01(inputs.risk);

  const max =
    weights.brandFit +
    weights.historicalEvidence +
    weights.marketSignal +
    weights.novelty +
    weights.reproducibility;
  const min = -(weights.saturation + weights.risk);
  const span = max - min;
  const normalized = span === 0 ? 0 : clamp01((raw - min) / span);
  return {
    raw: Math.round(raw * 1000) / 1000,
    normalized: Math.round(normalized * 1000) / 1000,
  };
}
