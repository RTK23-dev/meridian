/**
 * Angle Saturation & Creative Fatigue Tracking
 *
 * Models audience fatigue for creative angles based on impression volume,
 * frequency, and performance decay over time.
 */

export type FatigueAssessment = {
  angle: string;
  fatigueScore: number; // 0 (fresh) to 1 (fully saturated/exhausted)
  status: "FRESH" | "SCALING" | "FATIGUING" | "EXHAUSTED";
  recommendedAction: "SCALE" | "MONITOR" | "REFRESH_HOOK" | "PAUSE";
  reasons: string[];
};

export function assessAngleFatigue(input: {
  angle: string;
  totalImpressions: number;
  activeAdCount: number;
  recentCtrChangePercent?: number; // e.g. -25 for 25% drop
  daysActive: number;
}): FatigueAssessment {
  let score = 0;
  const reasons: string[] = [];

  // Impression volume scaling
  if (input.totalImpressions > 500_000) {
    score += 0.4;
    reasons.push(`High cumulative impression exposure (${input.totalImpressions.toLocaleString()}).`);
  } else if (input.totalImpressions > 100_000) {
    score += 0.2;
    reasons.push(`Moderate cumulative impression volume (${input.totalImpressions.toLocaleString()}).`);
  }

  // Active creative density
  if (input.activeAdCount >= 10) {
    score += 0.3;
    reasons.push(`${input.activeAdCount} active ads are running this same angle.`);
  }

  // CTR performance decay
  if (typeof input.recentCtrChangePercent === "number" && input.recentCtrChangePercent <= -20) {
    score += 0.3;
    reasons.push(`CTR has declined by ${Math.abs(input.recentCtrChangePercent)}% recently.`);
  }

  // Duration
  if (input.daysActive > 60) {
    score += 0.2;
    reasons.push(`Angle has been actively running for ${input.daysActive} days.`);
  }

  score = Math.min(1.0, Math.max(0.0, score));

  if (score >= 0.75) {
    return {
      angle: input.angle,
      fatigueScore: score,
      status: "EXHAUSTED",
      recommendedAction: "PAUSE",
      reasons,
    };
  }

  if (score >= 0.5) {
    return {
      angle: input.angle,
      fatigueScore: score,
      status: "FATIGUING",
      recommendedAction: "REFRESH_HOOK",
      reasons,
    };
  }

  if (score >= 0.25) {
    return {
      angle: input.angle,
      fatigueScore: score,
      status: "SCALING",
      recommendedAction: "MONITOR",
      reasons: reasons.length > 0 ? reasons : ["Angle is performing well with moderate scale."],
    };
  }

  return {
    angle: input.angle,
    fatigueScore: score,
    status: "FRESH",
    recommendedAction: "SCALE",
    reasons: ["Angle is fresh with minimal audience wear."],
  };
}
