// Aggregation of the timeline's samples into the measures that Video DNA stores (Bible 6.2 step 2, 4.1): motion, brightness
// and loudness per segment, and the loudness of each tenth of the video for the sound grammar. Pure. A series with no samples
// gives null (unknown); a window with no sample of its own takes the nearest sample, which is a measurement, not a guess.

import { analyzeConfig } from "./config.ts";

export type TimedValue = { atMs: number; value: number };
export type TimedLufs = { atMs: number; lufs: number | null };

/** The sample nearest to a time. The caller passes a non-empty series. */
function nearest(samples: readonly TimedValue[], ms: number): TimedValue {
  let best = samples[0] as TimedValue;
  for (const sample of samples) {
    if (Math.abs(sample.atMs - ms) < Math.abs(best.atMs - ms)) best = sample;
  }
  return best;
}

/**
 * The mean of the samples whose time is in [startMs, endMs). A window with none takes the sample nearest its middle. An empty
 * series gives null: nothing was measured.
 */
export function meanOver(
  samples: readonly TimedValue[],
  startMs: number,
  endMs: number,
): number | null {
  if (samples.length === 0) return null;
  const inside = samples.filter((sample) => sample.atMs >= startMs && sample.atMs < endMs);
  const pool = inside.length > 0 ? inside : [nearest(samples, (startMs + endMs) / 2)];
  return pool.reduce((total, sample) => total + sample.value, 0) / pool.length;
}

/** The loudness series as values: a silent step (null) is the BS.1770 gate, which is the lowest value a measure can report. */
export function loudnessValues(series: readonly TimedLufs[]): TimedValue[] {
  return series.map((sample) => ({
    atMs: sample.atMs,
    value: sample.lufs ?? analyzeConfig.silentLufs,
  }));
}

export type SegmentMeasures = { motion: number; brightness: number; loudnessLufs: number };

/**
 * The three measured fields of one segment. Null when a series has no samples at all (for example a reference with no audio, or
 * no picture): the caller then fails the check, because an unknown field cannot be stored.
 */
export function segmentMeasures(
  span: { startMs: number; endMs: number },
  series: {
    brightness: readonly TimedValue[];
    motion: readonly TimedValue[];
    loudness: readonly TimedLufs[];
  },
): SegmentMeasures | null {
  const motion = meanOver(series.motion, span.startMs, span.endMs);
  const brightness = meanOver(series.brightness, span.startMs, span.endMs);
  const loudness = meanOver(loudnessValues(series.loudness), span.startMs, span.endMs);
  if (motion === null || brightness === null || loudness === null) return null;
  return { motion, brightness, loudnessLufs: loudness };
}

/** The mean loudness of each tenth of the video, in LUFS (Bible 8.1 energyCurve). Null when there is no loudness series. */
export function tenthLoudness(durationMs: number, loudness: readonly TimedLufs[]): number[] | null {
  const values = loudnessValues(loudness);
  const curve: number[] = [];
  for (let tenth = 0; tenth < 10; tenth++) {
    const value = meanOver(values, (durationMs * tenth) / 10, (durationMs * (tenth + 1)) / 10);
    if (value === null) return null;
    curve.push(value);
  }
  return curve;
}
