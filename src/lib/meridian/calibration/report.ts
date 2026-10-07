export type CalibrationRow = {
  /** @deprecated Prefer `score`. Kept so stored reviewer rows still load. */
  probability?: number;
  /** Uncalibrated JEV score until this report says otherwise. */
  score?: number;
  outcome: boolean;
};

export type CalibrationBin = {
  from: number;
  to: number;
  count: number;
  meanProbability: number | null;
  meanScore: number | null;
  actualRate: number | null;
};

export type ReliabilityPoint = {
  predicted: number;
  observed: number;
  count: number;
};

function scoreOf(row: CalibrationRow): number {
  if (typeof row.score === "number" && Number.isFinite(row.score)) return row.score;
  if (typeof row.probability === "number" && Number.isFinite(row.probability)) return row.probability;
  return 0;
}

/**
 * Compares stated scores with later outcomes.
 * This report does not change thresholds. Scores are not probabilities until
 * Brier / ECE show they match outcomes.
 */
export function calibrationReport(rows: CalibrationRow[]): {
  bins: CalibrationBin[];
  reliability: ReliabilityPoint[];
  brierScore: number | null;
  ece: number | null;
  sampleSize: number;
  appliedToThresholds: false;
  note: string;
} {
  const width = 0.2;
  const bins: CalibrationBin[] = [];
  for (let start = 0; start < 1; start = Math.round((start + width) * 10) / 10) {
    const end = Math.round((start + width) * 10) / 10;
    const group = rows.filter((row) => {
      const score = scoreOf(row);
      return score >= start && (end === 1 ? score <= 1 : score < end);
    });
    const count = group.length;
    const meanScore = count === 0 ? null : round3(group.reduce((sum, row) => sum + scoreOf(row), 0) / count);
    bins.push({
      from: start,
      to: end,
      count,
      meanProbability: meanScore,
      meanScore,
      actualRate: count === 0 ? null : round3(group.filter((row) => row.outcome).length / count),
    });
  }
  const reliability: ReliabilityPoint[] = bins
    .filter((bin) => bin.count > 0 && bin.meanScore !== null && bin.actualRate !== null)
    .map((bin) => ({ predicted: bin.meanScore as number, observed: bin.actualRate as number, count: bin.count }));
  const brierScore =
    rows.length === 0
      ? null
      : round3(rows.reduce((sum, row) => {
          const score = scoreOf(row);
          const y = row.outcome ? 1 : 0;
          return sum + (score - y) ** 2;
        }, 0) / rows.length);
  const ece =
    rows.length === 0
      ? null
      : round3(
          bins.reduce((sum, bin) => {
            if (bin.count === 0 || bin.meanScore === null || bin.actualRate === null) return sum;
            return sum + (bin.count / rows.length) * Math.abs(bin.meanScore - bin.actualRate);
          }, 0),
        );
  return {
    bins,
    reliability,
    brierScore,
    ece,
    sampleSize: rows.length,
    appliedToThresholds: false,
    note: "JEV values are scores, not calibrated probabilities. This report does not move thresholds.",
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
