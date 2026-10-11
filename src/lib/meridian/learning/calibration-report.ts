/**
 * The decision calibration report: stated probabilities compared with the outcome a reviewer recorded.
 *
 * Below the minimum sample, the report says "not calibrated" and gives the count. It gives no Brier score and no calibration
 * error, because a number from a handful of outcomes would look like a measurement. At or above the minimum, it reports the
 * Brier score and the calibration error. Even then it is a measurement, not a calibration: it is never applied to a threshold or
 * a decision. A stated probability is a score until a calibration report (learning/calibration-gate.ts) says otherwise.
 *
 * A row with no finite probability in [0, 1], or no recorded outcome, is excluded and counted. It is never read as 0 or as a
 * failure.
 */
import { HELD_OUT_MINIMUM } from "./calibration-gate.ts";

export const CALIBRATION_REPORT_VERSION = "decision-calibration-report.v1";

/** The default minimum number of usable outcomes before any calibration number is reported. */
export const CALIBRATION_MINIMUM_SAMPLE = HELD_OUT_MINIMUM;

export type CalibrationOutcome = {
  /** The probability the engine stated for the decision. Null, non-finite, or outside [0, 1] excludes the row. */
  predicted: number | null | undefined;
  /** The outcome a reviewer recorded: true for approved, false for rejected. Null excludes the row. */
  observed: boolean | null | undefined;
};

export type CalibrationBin = {
  from: number;
  to: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
};

const BIN_COUNT = 5;

type CalibrationReportBase = {
  version: typeof CALIBRATION_REPORT_VERSION;
  /** Usable outcomes: rows with a stated probability and a recorded outcome. */
  sampleSize: number;
  minimumSample: number;
  /** Rows that could not be used, and why they were excluded in count. */
  excluded: number;
  /** The decision calibration report never changes a threshold or a decision. */
  appliedToDecisions: false;
};

export type CalibrationReportState =
  | (CalibrationReportBase & {
      state: "not_calibrated";
      label: "Not calibrated";
      reason: string;
    })
  | (CalibrationReportBase & {
      state: "measured";
      label: "Measured, not applied";
      brierScore: number;
      calibrationError: number;
      bins: CalibrationBin[];
      note: string;
    });

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** A row is usable only when its probability is a finite number in [0, 1] and an outcome was recorded. */
function isUsable(row: CalibrationOutcome): row is { predicted: number; observed: boolean } {
  return (
    typeof row.predicted === "number" &&
    Number.isFinite(row.predicted) &&
    row.predicted >= 0 &&
    row.predicted <= 1 &&
    typeof row.observed === "boolean"
  );
}

/**
 * The calibration state of a set of stated probabilities against their recorded outcomes. Pure: the caller loads the rows.
 * `minimumSample` defaults to HELD_OUT_MINIMUM. The state is "measured" only at or above that count.
 */
export function buildCalibrationReport(
  outcomes: readonly CalibrationOutcome[],
  options: { minimumSample?: number } = {},
): CalibrationReportState {
  const minimumSample = Number.isInteger(options.minimumSample) && (options.minimumSample as number) > 0
    ? (options.minimumSample as number)
    : CALIBRATION_MINIMUM_SAMPLE;
  const usable = outcomes.filter(isUsable);
  const excluded = outcomes.length - usable.length;
  const base: CalibrationReportBase = {
    version: CALIBRATION_REPORT_VERSION,
    sampleSize: usable.length,
    minimumSample,
    excluded,
    appliedToDecisions: false,
  };

  if (usable.length < minimumSample) {
    return {
      ...base,
      state: "not_calibrated",
      label: "Not calibrated",
      reason: `${usable.length} usable outcomes; ${minimumSample} are required before any calibration is measured.`,
    };
  }

  const n = usable.length;
  const brierScore = round3(usable.reduce((sum, row) => sum + (row.predicted - (row.observed ? 1 : 0)) ** 2, 0) / n);
  const bins: CalibrationBin[] = [];
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const from = index / BIN_COUNT;
    const to = (index + 1) / BIN_COUNT;
    const group = usable.filter((row) => {
      const bin = Math.min(BIN_COUNT - 1, Math.floor(row.predicted * BIN_COUNT));
      return bin === index;
    });
    const count = group.length;
    bins.push({
      from: round3(from),
      to: round3(to),
      count,
      meanPredicted: count === 0 ? null : round3(group.reduce((sum, row) => sum + row.predicted, 0) / count),
      observedRate: count === 0 ? null : round3(group.filter((row) => row.observed).length / count),
    });
  }
  const calibrationError = round3(
    bins.reduce((sum, bin) => {
      if (bin.count === 0 || bin.meanPredicted === null || bin.observedRate === null) return sum;
      return sum + (bin.count / n) * Math.abs(bin.meanPredicted - bin.observedRate);
    }, 0),
  );

  return {
    ...base,
    state: "measured",
    label: "Measured, not applied",
    brierScore,
    calibrationError,
    bins,
    note: `Measured on ${n} recorded outcomes. These are stated scores compared with outcomes. They are not applied to any threshold or decision.`,
  };
}

/** The one line the Calibration screen shows for a report's state. It says what was measured, and what was not. */
export function calibrationStateText(report: CalibrationReportState): string {
  if (report.state === "not_calibrated") {
    return `Not calibrated. ${report.sampleSize} usable outcomes; ${report.minimumSample} are required before any calibration is measured.`;
  }
  return `Measured on ${report.sampleSize} recorded outcomes, not applied to any decision. Brier score ${report.brierScore.toFixed(3)}, calibration error ${report.calibrationError.toFixed(3)}.`;
}
