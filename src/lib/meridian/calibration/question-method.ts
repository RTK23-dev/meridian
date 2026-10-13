/**
 * The calibration method for one grading question, from one brand's own measured outcomes (NORTH_STAR section 9, question 3).
 *
 * An observation is one pick's stated probability for one question, and whether the pick's creative met the success definition
 * (question-outcomes.ts). Observations fall into equal-width bins of stated probability. A bin qualifies when it holds at least
 * CALIBRATION_MINIMUM_BIN_COUNT observations and at least CALIBRATION_TARGET_SUCCESS_RATE of them succeeded.
 *
 * The threshold is the lower edge of the lowest bin from which every bin up to the top one qualifies. So a threshold t means: every
 * stated probability at or above t has been seen to succeed at the target rate, with enough observations in each bin. A brand with
 * fewer than CALIBRATION_MINIMUM_OBSERVATIONS observations is uncalibrated, whatever its bins show.
 *
 * These constants are the first values chosen for this method. The owner did not set them, and they are for review. They are named
 * here so one change moves every report. Changing any of them is a new method version.
 *
 * Pure: no database. The same observations give the same report, in any order.
 */

export const QUESTION_CALIBRATION_METHOD = "question-calibration.v1";

/** The observations one brand needs for one question version before any threshold is set. */
export const CALIBRATION_MINIMUM_OBSERVATIONS = 100;

/** Equal-width bins of stated probability: five bins of width 0.2. */
export const CALIBRATION_BIN_COUNT = 5;

/** The observations a bin needs before it can meet the target. */
export const CALIBRATION_MINIMUM_BIN_COUNT = 10;

/** The share of a bin's observations that must succeed for the bin to meet the target. */
export const CALIBRATION_TARGET_SUCCESS_RATE = 0.7;

export type CalibrationObservation = {
  /** The probability the engine stated for the question, in [0, 1]. Anything else is not an observation. */
  predicted: number;
  /** Whether the pick's creative met the success definition. */
  success: boolean;
};

export type ReliabilityBin = {
  from: number;
  to: number;
  count: number;
  meanPredicted: number | null;
  /** The share of the bin's observations that succeeded. Null when the bin is empty. */
  successRate: number | null;
  meetsTarget: boolean;
};

export type QuestionCalibration = {
  method: typeof QUESTION_CALIBRATION_METHOD;
  status: "calibrated" | "uncalibrated";
  /** Why the report is calibrated, or why it is not. It always gives the counts. */
  reason: string;
  sampleSize: number;
  minimumSample: number;
  /** The approve threshold for the question's stated probability. Null unless the report is calibrated. */
  threshold: number | null;
  reliability: ReliabilityBin[];
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isUsable(observation: CalibrationObservation): boolean {
  return (
    typeof observation.predicted === "number" &&
    Number.isFinite(observation.predicted) &&
    observation.predicted >= 0 &&
    observation.predicted <= 1 &&
    typeof observation.success === "boolean"
  );
}

/** The bin a stated probability falls in. A probability of 1 falls in the top bin. */
function binOf(predicted: number): number {
  return Math.min(CALIBRATION_BIN_COUNT - 1, Math.floor(predicted * CALIBRATION_BIN_COUNT));
}

export function calibrateQuestion(observations: readonly CalibrationObservation[]): QuestionCalibration {
  const usable = observations.filter(isUsable);
  const sampleSize = usable.length;
  const counts = new Array<number>(CALIBRATION_BIN_COUNT).fill(0);
  const sums = new Array<number>(CALIBRATION_BIN_COUNT).fill(0);
  const successes = new Array<number>(CALIBRATION_BIN_COUNT).fill(0);
  for (const observation of usable) {
    const bin = binOf(observation.predicted);
    counts[bin] += 1;
    sums[bin] += observation.predicted;
    if (observation.success) successes[bin] += 1;
  }

  const reliability: ReliabilityBin[] = counts.map((count, bin) => {
    const successRate = count === 0 ? null : successes[bin]! / count;
    return {
      from: round3(bin / CALIBRATION_BIN_COUNT),
      to: round3((bin + 1) / CALIBRATION_BIN_COUNT),
      count,
      meanPredicted: count === 0 ? null : round3(sums[bin]! / count),
      successRate: successRate === null ? null : round3(successRate),
      meetsTarget: count >= CALIBRATION_MINIMUM_BIN_COUNT && successRate !== null && successRate >= CALIBRATION_TARGET_SUCCESS_RATE,
    };
  });

  const base = {
    method: QUESTION_CALIBRATION_METHOD,
    sampleSize,
    minimumSample: CALIBRATION_MINIMUM_OBSERVATIONS,
    reliability,
  } as const;

  if (sampleSize < CALIBRATION_MINIMUM_OBSERVATIONS) {
    return {
      ...base,
      status: "uncalibrated",
      threshold: null,
      reason: `${sampleSize} of ${CALIBRATION_MINIMUM_OBSERVATIONS} observations measured. ${CALIBRATION_MINIMUM_OBSERVATIONS} are required before a threshold is set.`,
    };
  }

  // The lowest bin from which every bin up to the top one meets the target.
  let lowest: number | null = null;
  for (let bin = CALIBRATION_BIN_COUNT - 1; bin >= 0; bin -= 1) {
    if (!reliability[bin]!.meetsTarget) break;
    lowest = bin;
  }
  if (lowest === null) {
    const top = reliability[CALIBRATION_BIN_COUNT - 1]!;
    const topReason = top.count < CALIBRATION_MINIMUM_BIN_COUNT
      ? `${top.count} observations at or above ${top.from}; ${CALIBRATION_MINIMUM_BIN_COUNT} are required`
      : `a success rate of ${top.successRate} at or above ${top.from}; ${CALIBRATION_TARGET_SUCCESS_RATE} is required`;
    return {
      ...base,
      status: "uncalibrated",
      threshold: null,
      reason: `${sampleSize} observations measured, but no threshold meets the rule. The top bin has ${topReason}. No threshold is set.`,
    };
  }

  const threshold = reliability[lowest]!.from;
  return {
    ...base,
    status: "calibrated",
    threshold,
    reason: `${sampleSize} observations measured. Every stated probability from ${threshold} up has at least ${CALIBRATION_MINIMUM_BIN_COUNT} observations and a success rate of at least ${CALIBRATION_TARGET_SUCCESS_RATE}.`,
  };
}
