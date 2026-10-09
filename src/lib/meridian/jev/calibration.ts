/**
 * JEV Empirical Calibration Framework
 *
 * Measures calibration accuracy of probabilistic JEV questions against observed outcomes:
 * - Brier score: 1/N * sum((p_i - y_i)^2)
 * - Calibration curve / reliability diagram (binned predicted vs actual)
 * - Abstention rate (insufficient evidence / uncertain)
 * - Separation between seed priors and validated calibration reports
 */

export type CalibrationDataPoint = {
  predictedProbability: number;
  actualOutcome: boolean; // 1 = true, 0 = false
};

export type CalibrationReport = {
  sampleSize: number;
  brierScore: number;
  logLoss: number;
  expectedCalibrationError: number;
  abstentionCount: number;
  abstentionRate: number;
  bins: Array<{
    binStart: number;
    binEnd: number;
    count: number;
    meanPredicted: number;
    meanActual: number;
  }>;
};

export function computeCalibrationMetrics(
  points: CalibrationDataPoint[],
  totalAttemptsWithAbstentions?: number,
  binCount = 10,
): CalibrationReport {
  const n = points.length;
  const total = totalAttemptsWithAbstentions ?? n;
  const abstentionCount = Math.max(0, total - n);
  const abstentionRate = total > 0 ? abstentionCount / total : 0;

  if (n === 0) {
    return {
      sampleSize: 0,
      brierScore: 0,
      logLoss: 0,
      expectedCalibrationError: 0,
      abstentionCount,
      abstentionRate,
      bins: [],
    };
  }

  // 1. Brier score & Log Loss
  let sumSquaredError = 0;
  let sumLogLoss = 0;
  const eps = 1e-15;

  for (const pt of points) {
    const y = pt.actualOutcome ? 1 : 0;
    const p = Math.max(eps, Math.min(1 - eps, pt.predictedProbability));
    sumSquaredError += (p - y) ** 2;
    sumLogLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }

  const brierScore = sumSquaredError / n;
  const logLoss = sumLogLoss / n;

  // 2. Reliability Bins
  const binSize = 1.0 / binCount;
  const binBuckets: Array<{
    start: number;
    end: number;
    predicted: number[];
    actual: number[];
  }> = [];

  for (let i = 0; i < binCount; i++) {
    binBuckets.push({
      start: i * binSize,
      end: (i + 1) * binSize,
      predicted: [],
      actual: [],
    });
  }

  for (const pt of points) {
    const binIdx = Math.min(
      binCount - 1,
      Math.max(0, Math.floor(pt.predictedProbability / binSize)),
    );
    binBuckets[binIdx].predicted.push(pt.predictedProbability);
    binBuckets[binIdx].actual.push(pt.actualOutcome ? 1 : 0);
  }

  let ece = 0;
  const bins = binBuckets.map((b) => {
    const count = b.predicted.length;
    if (count === 0) {
      return {
        binStart: b.start,
        binEnd: b.end,
        count: 0,
        meanPredicted: (b.start + b.end) / 2,
        meanActual: 0,
      };
    }
    const meanPredicted = b.predicted.reduce((sum, v) => sum + v, 0) / count;
    const meanActual = b.actual.reduce((sum, v) => sum + v, 0) / count;
    ece += (count / n) * Math.abs(meanPredicted - meanActual);
    return {
      binStart: b.start,
      binEnd: b.end,
      count,
      meanPredicted,
      meanActual,
    };
  });

  return {
    sampleSize: n,
    brierScore: Number(brierScore.toFixed(4)),
    logLoss: Number(logLoss.toFixed(4)),
    expectedCalibrationError: Number(ece.toFixed(4)),
    abstentionCount,
    abstentionRate: Number(abstentionRate.toFixed(4)),
    bins,
  };
}

export function computeBrierScore(
  samples: Array<{ probability: number; outcome: number | boolean }>,
): number {
  if (samples.length === 0) return 0;
  const metrics = computeCalibrationMetrics(
    samples.map((s) => ({
      predictedProbability: s.probability,
      actualOutcome: Boolean(s.outcome),
    })),
  );
  return metrics.brierScore;
}

export function computeLogLoss(
  samples: Array<{ probability: number; outcome: number | boolean }>,
): number {
  if (samples.length === 0) return 0;
  const metrics = computeCalibrationMetrics(
    samples.map((s) => ({
      predictedProbability: s.probability,
      actualOutcome: Boolean(s.outcome),
    })),
  );
  return metrics.logLoss;
}

export function assessReliability(
  samples: Array<{ probability: number; outcome: number | boolean }>,
): {
  brierScore: number;
  logLoss: number;
  expectedCalibrationError: number;
  calibrationGrade: "well_calibrated" | "moderate" | "uncalibrated";
} {
  const metrics = computeCalibrationMetrics(
    samples.map((s) => ({
      predictedProbability: s.probability,
      actualOutcome: Boolean(s.outcome),
    })),
  );

  let grade: "well_calibrated" | "moderate" | "uncalibrated" = "well_calibrated";
  if (metrics.brierScore > 0.25 || metrics.expectedCalibrationError > 0.20) {
    grade = "uncalibrated";
  } else if (metrics.brierScore > 0.15 || metrics.expectedCalibrationError > 0.10) {
    grade = "moderate";
  }

  return {
    brierScore: metrics.brierScore,
    logLoss: metrics.logLoss,
    expectedCalibrationError: metrics.expectedCalibrationError,
    calibrationGrade: grade,
  };
}

