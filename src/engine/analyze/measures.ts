// The measures of one rendered video, from the media functions' readings (round 3, K22). Pure: the caller runs the media functions and passes
// their readings in, so the same numbers come out of the preset compare script and of a test on recorded readings. The names are the ones
// cookbook checks name (cookbooks/checks.ts), so a check reads its measure by name.

import { median, percentile } from "./beats.ts";
import { loopOf, zoomJumps, type ZoomJump } from "./zoom.ts";

/** What the media functions read from one video. A reading that could not be made is null. */
export type MediaReadings = {
  durationMs: number | null;
  cutsMs: readonly number[];
  pairs: Parameters<typeof zoomJumps>[0];
  loopDistance: number | null;
  meanMotion: number | null;
  flickerScore: number | null;
  brightness: readonly number[];
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
};

export type Measures = Record<string, number | string | null>;

/** The timing measures, which need a duration. Without one (or with zero), they are unknown, not zero or a guess (CLAUDE.md rule 1). */
function timingOf(d: number, cut: readonly number[], jumps: ZoomJump[]) {
  const bounds = [0, ...cut, d];
  const shots = bounds.slice(1).map((end, i) => end - (bounds[i] ?? 0));
  const ins = jumps.filter((jump) => jump.scale > 1);
  const interrupts = [...new Set([...cut, ...jumps.map((jump) => jump.atMs)])].sort((a, b) => a - b);
  const ib = [0, ...interrupts, d];
  const gaps = ib.slice(1).map((end, i) => end - (ib[i] ?? 0)).filter((gap) => gap > 0);
  return {
    shotP25Ms: Math.round(percentile(shots, 25)),
    shotP50Ms: Math.round(percentile(shots, 50)),
    shotP75Ms: Math.round(percentile(shots, 75)),
    punchInsPer10s: Number((ins.length / (d / 10_000)).toFixed(2)),
    interruptMedianMs: gaps.length > 0 ? Math.round(median(gaps)) : null,
  };
}

/** The measures of one video, by name. A reading that is null stays null; numbers are rounded as the compare report rounds them. */
export function measuresOf(readings: MediaReadings): Measures {
  const d = readings.durationMs;
  const cut = [...readings.cutsMs];
  const jumps = zoomJumps(readings.pairs) ?? [];
  const timing = d !== null && d > 0 ? timingOf(d, cut, jumps) : null;
  const ins = jumps.filter((jump) => jump.scale > 1);
  const brightness = readings.brightness;
  return {
    durationMs: d,
    hardCuts: cut.length,
    firstCutMs: cut[0] ?? null,
    shotP25Ms: timing?.shotP25Ms ?? null,
    shotP50Ms: timing?.shotP50Ms ?? null,
    shotP75Ms: timing?.shotP75Ms ?? null,
    zoomJumps: jumps.length,
    punchInsPer10s: timing?.punchInsPer10s ?? null,
    punchInScale: ins.length > 0 ? Number(median(ins.map((jump) => jump.scale)).toFixed(2)) : null,
    interruptMedianMs: timing?.interruptMedianMs ?? null,
    meanMotion: readings.meanMotion === null ? null : Number(readings.meanMotion.toFixed(3)),
    flickerScore: readings.flickerScore === null ? null : Number(readings.flickerScore.toFixed(3)),
    meanBrightness: brightness.length > 0 ? Number((brightness.reduce((a, b) => a + b, 0) / brightness.length).toFixed(3)) : null,
    integratedLufs: readings.integratedLufs,
    loudnessRangeLu: readings.loudnessRangeLu,
    loopDistance: readings.loopDistance === null ? null : Number(readings.loopDistance.toFixed(3)),
    endsOnLoop: String(loopOf(readings.loopDistance)),
    cutsMs: cut.join(" "),
  };
}

/** The measures a check can compare: the numeric ones. A text measure (endsOnLoop, cutsMs) is not a number, so a check on it is unknown. */
export function numericMeasures(measures: Measures): Record<string, number | null> {
  const numeric: Record<string, number | null> = {};
  for (const [name, value] of Object.entries(measures)) {
    if (typeof value === "number") numeric[name] = value;
    else if (value === null) numeric[name] = null;
  }
  return numeric;
}
