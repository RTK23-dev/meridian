import { learningDirection, type LearningDirection } from "@/lib/meridian/learning/engine";
import { NOT_ENOUGH_RESULTS } from "./metrics";

/** Zero-sample rule: a count below 1, or a missing count, is not a result. */
export function hasSample(count: number | null | undefined): boolean {
  return typeof count === "number" && Number.isFinite(count) && count >= 1;
}

/** Stored lift is relative to the baseline: 0.12 means 12% above the baseline rate. */
export function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return NOT_ENOUGH_RESULTS;
  const percent = value * 100;
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return "0.0%";
  const sign = rounded > 0 ? "+" : "-";
  return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}

export function directionLabel(direction: LearningDirection): string {
  switch (direction) {
    case "POSITIVE":
      return "Up";
    case "NEGATIVE":
      return "Down";
    case "NEUTRAL":
      return "No clear difference";
    case "INSUFFICIENT_EVIDENCE":
      return NOT_ENOUGH_RESULTS;
  }
}

export function stateLabel(state: string): string {
  const key = state.trim().toUpperCase();
  if (key === "VALIDATED") return "Validated";
  if (key === "OBSERVED") return "Observed";
  if (key === "INFERRED") return "Inferred";
  return key ? key.charAt(0) + key.slice(1).toLowerCase() : "Unknown";
}

export type PatternEvidence = {
  lift: number;
  sampleSize: number;
  impressions: number;
  state: string;
  /** Present only when the stored pattern has an interval. No interval is stored today. */
  interval?: { low: number; high: number } | null;
};

export type PatternDisplay = {
  direction: LearningDirection;
  directionLabel: string;
  liftText: string;
  intervalText: string | null;
  stateText: string;
  hasEvidence: boolean;
};

/**
 * Direction comes from the engine's own rule (learningDirection), so the table uses the thresholds
 * the engine uses. Lift is shown only when there is a sample and impressions. Otherwise both read
 * "Not enough results".
 */
export function patternDisplay(pattern: PatternEvidence): PatternDisplay {
  const hasEvidence = hasSample(pattern.sampleSize) && hasSample(pattern.impressions);
  const direction = learningDirection({
    lift: pattern.lift,
    sampleSize: pattern.sampleSize,
    impressions: pattern.impressions,
  });
  const interval = pattern.interval;
  const hasInterval = hasEvidence && interval != null && Number.isFinite(interval.low) && Number.isFinite(interval.high);
  return {
    direction,
    directionLabel: directionLabel(direction),
    liftText: hasEvidence ? formatSignedPercent(pattern.lift) : NOT_ENOUGH_RESULTS,
    intervalText: hasInterval ? `from ${formatSignedPercent(interval.low)} to ${formatSignedPercent(interval.high)}` : null,
    stateText: stateLabel(pattern.state),
    hasEvidence,
  };
}
