// The edit grammar of a reference (Bible 8.1). Pure and deterministic: the same measurements give the same grammar. It runs
// inside analyze_reference, on the cut times, the segments, the timeline and the readings of captions, zoom and loop. Each field
// is computed only from what was measured. A field whose measurement is missing is listed in `unknown`, and no grammar is
// returned, because the contract has no null: an unknown value stays unknown and fails the dna gate (CLAUDE.md working rule 1).
//
// Owned by eng-media-assets (W6). The rest of src/engine/edit/ belongs to eng-edit-compose.

import {
  editGrammarSchema,
  type EditGrammar,
  type ReferenceShotType,
} from "../contracts/analysis.ts";
import type { BeatRole } from "../contracts/request.ts";
import { analyzeConfig } from "../analyze/config.ts";
import { median, percentile, type SoundMeasures } from "../analyze/beats.ts";
import { meanOver, tenthLoudness, type TimedLufs, type TimedValue } from "../analyze/measure.ts";

/** A segment as the grammar reads it: its span, its shot type and its beat role. */
export type GrammarSegment = {
  startMs: number;
  endMs: number;
  shotType: ReferenceShotType;
  beatRole?: BeatRole;
};

/** The caption block as measured on frames (OCR, Bible 8.1 captions). Its shape is the contract's. */
export type MeasuredCaptions = EditGrammar["captions"];

/** The zoom measures (Bible 8.1 motion): each jump is a sudden scale change, `scale` is the new scale over the old. */
export type MeasuredZoom = {
  jumps: ReadonlyArray<{ atMs: number; scale: number }>;
  shake: boolean;
  speedRamps: boolean;
};

export type GrammarInput = {
  durationMs: number;
  /** Scene-cut times in milliseconds, ascending (the cut list of Bible 6.2 step 2). */
  cutsMs: readonly number[];
  segments: readonly GrammarSegment[];
  /** The sound measures, or null when the reference has no audio. */
  sound: SoundMeasures | null;
  /** The momentary loudness series, empty when there is no audio. */
  loudness: readonly TimedLufs[];
  brightness: readonly TimedValue[];
  motion: readonly TimedValue[];
  captions: MeasuredCaptions | null;
  zoom: MeasuredZoom | null;
  /** Whether the last frame is within the image-similarity threshold of the first (Bible 8.1 endsOnLoop), or null. */
  loop: boolean | null;
};

export type GrammarResult =
  { grammar: EditGrammar; unknown: [] } | { grammar: null; unknown: string[] };

const STAGE = "edit.grammar";

/**
 * hookPayoffMs (Bible 8.1): the start of the first segment whose beat role is payoff or item; else the second cut; else the
 * end of the video. Exported so that the sound measures read the same payoff the grammar reports.
 */
export function hookPayoffOf(
  segments: readonly GrammarSegment[],
  cuts: readonly number[],
  durationMs: number,
): number {
  const payoff = [...segments]
    .sort((a, b) => a.startMs - b.startMs)
    .find((segment) => segment.beatRole === "payoff" || segment.beatRole === "item");
  return payoff?.startMs ?? cuts[1] ?? durationMs;
}

export function sortedCuts(durationMs: number, cutsMs: readonly number[]): number[] {
  return [...new Set(cutsMs.filter((ms) => ms > 0 && ms < durationMs))].sort((a, b) => a - b);
}

/** Shot durations: the spans between consecutive boundaries of 0, the cuts and the end. */
function shotLengths(durationMs: number, cuts: readonly number[]): number[] {
  const boundaries = [0, ...cuts, durationMs];
  const lengths: number[] = [];
  for (let index = 1; index < boundaries.length; index++) {
    const length = (boundaries[index] ?? 0) - (boundaries[index - 1] ?? 0);
    if (length > 0) lengths.push(length);
  }
  return lengths;
}

/** The segment that holds a time, if any. */
function segmentAt(segments: readonly GrammarSegment[], ms: number): GrammarSegment | undefined {
  return segments.find((segment) => segment.startMs <= ms && ms < segment.endMs);
}

/** Pure: the grammar of one reference, or the list of what could not be measured. */
export function computeEditGrammar(input: GrammarInput): GrammarResult {
  const unknown: string[] = [];
  const d = input.durationMs;
  const cuts = sortedCuts(d, input.cutsMs);

  // hookFirstCutMs: the first scene cut. With no cut the first shot runs to the end, so the first cut is the end.
  const hookFirstCutMs = cuts[0] ?? d;

  const hookPayoffMs = hookPayoffOf(input.segments, cuts, d);

  // shotLengthMs: quartiles of the shot durations; curve = the median shot length in each tenth of the video.
  const lengths = shotLengths(d, cuts);
  const shotLengthMs = {
    p25: Math.round(percentile(lengths, 25)),
    p50: Math.round(percentile(lengths, 50)),
    p75: Math.round(percentile(lengths, 75)),
    curve: Array.from({ length: 10 }, (_, tenth) => {
      const from = (d * tenth) / 10;
      const to = (d * (tenth + 1)) / 10;
      const boundaries = [0, ...cuts, d];
      const overlapping: number[] = [];
      for (let index = 1; index < boundaries.length; index++) {
        const start = boundaries[index - 1] ?? 0;
        const end = boundaries[index] ?? 0;
        if (end > start && start < to && end > from) overlapping.push(end - start);
      }
      return Math.round(median(overlapping.length > 0 ? overlapping : [d]));
    }),
  };

  // Zoom-dependent fields (rehookIntervalMs, motion, transitions) need the zoom reading. Without it they are unknown.
  const zoom = input.zoom;
  let rehookIntervalMs: number | null = null;
  let motion: EditGrammar["motion"] | null = null;
  let transitions: EditGrammar["transitions"] | null = null;
  if (zoom === null) {
    unknown.push(
      "zoom (zoom jumps and shake, Bible 8.1): no zoom reading is connected, so rehookIntervalMs, motion and transitions are unknown",
    );
  } else {
    // rehookIntervalMs: the median gap between pattern interrupts: a cut that changes the shot type, a zoom jump, or a sound hit.
    const shotChanges = cuts.filter((cut) => {
      const before = segmentAt(input.segments, cut - 1);
      const after = segmentAt(input.segments, cut);
      return before !== undefined && after !== undefined && before.shotType !== after.shotType;
    });
    const interrupts = [
      ...new Set([
        ...shotChanges,
        ...zoom.jumps.map((jump) => jump.atMs),
        ...(input.sound?.hitsMs ?? []),
      ]),
    ]
      .filter((ms) => ms > 0 && ms < d)
      .sort((a, b) => a - b);
    const boundaries = [0, ...interrupts, d];
    const gaps: number[] = [];
    for (let index = 1; index < boundaries.length; index++)
      gaps.push((boundaries[index] ?? 0) - (boundaries[index - 1] ?? 0));
    rehookIntervalMs = Math.round(median(gaps.filter((gap) => gap > 0)));

    // motion: zoom jumps per 10 s and their median scale; shake and speed ramps as measured. No jump means scale 1 (no change).
    const scales = zoom.jumps
      .map((jump) => jump.scale)
      .filter((scale) => Number.isFinite(scale) && scale > 0);
    motion = {
      punchInsPer10s: d > 0 ? zoom.jumps.length / (d / 10_000) : 0,
      punchInScale: scales.length > 0 ? median(scales) : 1,
      shakeOnImpact: zoom.shake,
      speedRamps: zoom.speedRamps,
    };

    // transitions: each cut is zoom (a zoom jump at it), flash (brightness step), whip (motion spike) or hard.
    if (cuts.length === 0) {
      transitions = [];
    } else if (input.brightness.length === 0 || input.motion.length === 0) {
      unknown.push("transitions (cut classes, Bible 8.1): no picture was measured");
    } else {
      const counts = new Map<string, number>();
      for (const cut of cuts) {
        const zoomCut = zoom.jumps.some(
          (jump) => Math.abs(jump.atMs - cut) <= analyzeConfig.zoomCutWindowMs,
        );
        const before = meanOver(input.brightness, cut - analyzeConfig.cutWindowMs, cut);
        const after = meanOver(input.brightness, cut, cut + analyzeConfig.cutWindowMs);
        const flash =
          before !== null &&
          after !== null &&
          Math.abs(after - before) >= analyzeConfig.flashBrightnessDelta;
        const spike = meanOver(input.motion, cut, cut + analyzeConfig.cutWindowMs) ?? 0;
        const kind = zoomCut
          ? "zoom"
          : flash
            ? "flash"
            : spike >= analyzeConfig.whipMotion
              ? "whip"
              : "hard";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      transitions = [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([kind, count]) => ({ kind, share: count / cuts.length }));
    }
  }

  // captions: measured on frames (OCR). No reader, no value.
  if (input.captions === null) {
    unknown.push(
      "captions (words per caption, position, style and highlight, Bible 6.2 step 6 and 8.1): no OCR reading is connected",
    );
  }

  // sound: from the audio. A reference without audio has no sound grammar.
  let sound: EditGrammar["sound"] | null = null;
  if (input.sound === null) {
    unknown.push(
      "sound (music, tempo, energy and sound effects, Bible 8.1): the reference has no measured audio",
    );
  } else {
    const energyCurve = tenthLoudness(d, input.loudness);
    if (energyCurve === null) {
      unknown.push("sound energy (Bible 8.1): no loudness series was measured");
    } else {
      sound = {
        music: input.sound.music,
        ...(input.sound.bpm === null ? {} : { bpm: input.sound.bpm }),
        energyCurve,
        sfxPer10s: input.sound.sfxPer10s,
        ...(input.sound.silenceBeforePayoffMs === null
          ? {}
          : { silenceBeforePayoffMs: input.sound.silenceBeforePayoffMs }),
      };
    }
  }

  // endsOnLoop: the frame reading decides it. No reading, no value.
  if (input.loop === null) {
    unknown.push(
      "loop (the last frame against the first, Bible 8.1): no image-similarity reading is connected",
    );
  }

  if (
    unknown.length > 0 ||
    input.captions === null ||
    motion === null ||
    transitions === null ||
    sound === null ||
    rehookIntervalMs === null ||
    input.loop === null
  ) {
    return { grammar: null, unknown };
  }

  const candidate = {
    hookFirstCutMs,
    hookPayoffMs,
    shotLengthMs,
    rehookIntervalMs,
    captions: input.captions,
    motion,
    transitions,
    sound,
    endsOnLoop: input.loop,
  };
  const parsed = editGrammarSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      grammar: null,
      unknown: [
        `${STAGE}: the computed grammar does not match its contract (${parsed.error.issues[0]?.message ?? "invalid"})`,
      ],
    };
  }
  return { grammar: parsed.data, unknown: [] };
}
