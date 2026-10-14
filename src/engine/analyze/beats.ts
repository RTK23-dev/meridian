// The beat grid and the sound measures of a reference (Bible 6.2 step 2, 8.1 sound and rehookIntervalMs). Pure functions over
// the 10 ms RMS envelope that the timeline measures (media/timeline.ts), and over the spoken word spans of the transcript.
// Nothing here calls a model or a function. An input that cannot support a measure returns null, never a default.

import { EngineError } from "../contracts/errors.ts";
import { analyzeConfig } from "./config.ts";

/** A span of speech in milliseconds (a spoken word, or the whole transcript's words). */
export type SpeechSpan = { startMs: number; endMs: number };

/** Decibels full scale of a linear RMS value (0 to 1). Silence and anything below -100 dBFS read as -100. */
export function dbfs(rms: number): number {
  return rms <= 1e-5 ? -100 : 20 * Math.log10(rms);
}

/** Linear-interpolated percentile of a non-empty list (the same rule as numpy's default). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new EngineError("invalid_input", "a percentile needs at least one value", {
      stage: "analyze.beats",
    });
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (p / 100) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (position - low);
}

/** The median of a non-empty list: the 50th percentile, interpolated between the two middle values for an even count. */
export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

/** Onset strength per window: how far the level rose over the last onsetLagMs (decibels, never negative). */
export function onsetStrength(rms: readonly number[], stepMs: number): number[] {
  const lag = Math.max(1, Math.round(analyzeConfig.onsetLagMs / stepMs));
  const levels = rms.map(dbfs);
  return levels.map((level, index) =>
    index < lag ? 0 : Math.max(0, level - (levels[index - lag] ?? level)),
  );
}

/**
 * Sound hits: local maxima of the onset strength above the onsetPercentile of the whole strength, at least onsetRefractoryMs
 * apart. Returns each hit's time in milliseconds. A silent reference has no hits.
 */
export function soundHits(strength: readonly number[], stepMs: number): number[] {
  if (strength.length < 3) return [];
  const threshold = percentile(strength, analyzeConfig.onsetPercentile);
  const refractorySteps = Math.max(1, Math.round(analyzeConfig.onsetRefractoryMs / stepMs));
  const hits: number[] = [];
  let last = -Infinity;
  for (let index = 1; index < strength.length - 1; index++) {
    const value = strength[index] ?? 0;
    if (value <= 0 || value <= threshold) continue;
    if (value < (strength[index - 1] ?? 0) || value <= (strength[index + 1] ?? 0)) continue;
    if (index - last < refractorySteps) continue;
    hits.push(index * stepMs);
    last = index;
  }
  return hits;
}

/**
 * The tempo from the onset envelope, as a whole number of beats per minute, or null when no tempo stands out. The
 * autocorrelation is searched over the tempo range. Among the lags that score nearly as high as the best, the shortest is
 * taken, so a multiple of the true beat is not reported as the tempo.
 */
export function estimateBpm(strength: readonly number[], stepMs: number): number | null {
  const { min, max, minPeakRatio, harmonicShare } = analyzeConfig.bpm;
  const lagMin = Math.max(1, Math.round(60_000 / max / stepMs));
  const lagMax = Math.round(60_000 / min / stepMs);
  const n = strength.length;
  if (n <= 2 * lagMax) return null;
  const scores: Array<{ lag: number; score: number }> = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    for (let index = 0; index + lag < n; index++)
      sum += (strength[index] ?? 0) * (strength[index + lag] ?? 0);
    scores.push({ lag, score: sum / (n - lag) });
  }
  const mean = scores.reduce((total, item) => total + item.score, 0) / scores.length;
  const best = Math.max(...scores.map((item) => item.score));
  if (!(mean > 0) || !(best > 0) || best / mean < minPeakRatio) return null;
  const chosen = scores.find((item) => item.score >= harmonicShare * best);
  if (chosen === undefined) return null;
  return Math.round(60_000 / (chosen.lag * stepMs));
}

/** One flag per window: true when the window's start is inside a speech span. */
export function spokenWindows(
  spans: readonly SpeechSpan[],
  stepMs: number,
  count: number,
  paddingMs = 0,
): boolean[] {
  const mask = new Array<boolean>(count).fill(false);
  for (const span of spans) {
    const from = Math.max(0, Math.floor((span.startMs - paddingMs) / stepMs));
    const to = Math.min(count, Math.ceil((span.endMs + paddingMs) / stepMs));
    for (let index = from; index < to; index++) mask[index] = true;
  }
  return mask;
}

/**
 * The share of the whole duration in which non-speech energy is above the floor (Bible 8.1: music is present when this is
 * over 60%). Windows inside speech do not count. The denominator is every window, so a silent stretch counts against it.
 */
export function musicShare(
  rms: readonly number[],
  stepMs: number,
  speech: readonly SpeechSpan[],
  floorDbfs: number,
): number {
  if (rms.length === 0) return 0;
  const spoken = spokenWindows(speech, stepMs, rms.length);
  let loud = 0;
  rms.forEach((value, index) => {
    if (!spoken[index] && dbfs(value) > floorDbfs) loud += 1;
  });
  return loud / rms.length;
}

/** The silence that ends at the payoff, in milliseconds, when it is longer than silenceBeforePayoffMinMs. Otherwise null. */
export function silenceBeforeMs(
  payoffMs: number,
  rms: readonly number[],
  stepMs: number,
): number | null {
  let index = Math.min(rms.length - 1, Math.floor(payoffMs / stepMs) - 1);
  let steps = 0;
  while (index >= 0 && dbfs(rms[index] ?? 0) < analyzeConfig.silenceFloorDbfs) {
    steps += 1;
    index -= 1;
  }
  const gap = steps * stepMs;
  return gap > analyzeConfig.silenceBeforePayoffMinMs ? gap : null;
}

export type SoundMeasures = {
  /** Sound hits in milliseconds, from the onset envelope. */
  hitsMs: number[];
  /** Hits that are not aligned to a spoken word: the sound effects (Bible 8.1). */
  soundEffectHitsMs: number[];
  musicShare: number;
  music: boolean;
  /** The tempo, or null when none stands out. */
  bpm: number | null;
  /** Sound effects per 10 s of the duration (Bible 8.1). */
  sfxPer10s: number;
  /** The silence before the payoff, or null when there is none longer than the minimum. */
  silenceBeforePayoffMs: number | null;
};

/** The sound measures of one reference, from its envelope, its speech spans, and the payoff (when one is found). */
export function measureSound(input: {
  rms: readonly number[];
  stepMs: number;
  durationMs: number;
  speech: readonly SpeechSpan[];
  payoffMs: number | null;
}): SoundMeasures {
  const strength = onsetStrength(input.rms, input.stepMs);
  const hitsMs = soundHits(strength, input.stepMs);
  const pad = analyzeConfig.speechPaddingMs;
  const nearSpeech = (ms: number): boolean =>
    input.speech.some((span) => ms >= span.startMs - pad && ms <= span.endMs + pad);
  const soundEffectHitsMs = hitsMs.filter((ms) => !nearSpeech(ms));
  const share = musicShare(input.rms, input.stepMs, input.speech, analyzeConfig.musicFloorDbfs);
  const per10s = input.durationMs > 0 ? soundEffectHitsMs.length / (input.durationMs / 10_000) : 0;
  return {
    hitsMs,
    soundEffectHitsMs,
    musicShare: share,
    music: share > analyzeConfig.musicShareMin,
    bpm: estimateBpm(strength, input.stepMs),
    sfxPer10s: per10s,
    silenceBeforePayoffMs:
      input.payoffMs === null ? null : silenceBeforeMs(input.payoffMs, input.rms, input.stepMs),
  };
}
