export type CalibrationRow = {
  probability: number;
  outcome: boolean;
};

export type CalibrationBin = {
  from: number;
  to: number;
  count: number;
  meanProbability: number | null;
  actualRate: number | null;
};

/**
 * Compares stated probabilities with later outcomes.
 * This report does not change thresholds.
 */
export function calibrationReport(rows: CalibrationRow[]): {
  bins: CalibrationBin[];
  appliedToThresholds: false;
  note: string;
} {
  const width = 0.2;
  const bins: CalibrationBin[] = [];
  for (let start = 0; start < 1; start = Math.round((start + width) * 10) / 10) {
    const end = Math.round((start + width) * 10) / 10;
    const group = rows.filter((row) => row.probability >= start && (end === 1 ? row.probability <= 1 : row.probability < end));
    const count = group.length;
    bins.push({
      from: start,
      to: end,
      count,
      meanProbability: count === 0 ? null : round3(group.reduce((sum, row) => sum + row.probability, 0) / count),
      actualRate: count === 0 ? null : round3(group.filter((row) => row.outcome).length / count),
    });
  }
  return {
    bins,
    appliedToThresholds: false,
    note: "Calibration is recorded only. Thresholds stay where the question defined them.",
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
