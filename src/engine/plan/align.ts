// Steps 1 and 2 of the plan (Bible 6.4): align the script's beats to the reference segments by role and relative position, then
// split each beat into shots whose lengths follow the reference's shot-length curve (8.1). Pure. The voice is the clock: every
// span comes from the voice track's beat spans (6.3), and the shots tile the voice exactly, from 0 to its duration.
//
// Also here: the shot flags of 7.2 (rules 2 to 4) that the request can answer. A shot shows the product when a request on its
// beat is classified real_product (rule 2). Text the viewer asks to see in the picture is text in pixels (rule 3). A hands
// request on a product shot is hands on the product (rule 4). A component whose text limit the shot's words exceed is a refusal.

import { createHash } from "node:crypto";
import { thresholds } from "../config/thresholds.ts";
import { EngineError, encodeUlid, type BeatRole, type Decision, type ReferenceShotType } from "../contracts/index.ts";
import { promptAsksForText } from "../review/gates/promptText.ts";
import type { VisualClassification } from "../review/gates/request.ts";
import { componentRefusals, emphasisIn } from "./sources.ts";
import type { ClassifiedRequest, ShotInput } from "./types.ts";

/** Hands and the verbs of handling, for rule 4. A request that names them, on a product shot, is hands on the product. */
const HANDS_REQUEST = /\b(hands?|fingers?|holds?|holding|grips?|gripping|pours?|pouring|squeez\w*|press(?:es|ing)?|touch(?:es|ing)?)\b/i;

export type AlignBeat = { beatId: string; role: BeatRole; emphasis?: readonly string[] };

export type AlignInput = {
  /** Used in the shot ids, which are deterministic: the same request gives the same ids (shotIdFor). */
  requestId: string;
  /** The script beats in order. */
  beats: readonly AlignBeat[];
  /** The visual requests of the request (ProductionRequest.visualRequests). */
  visualRequests: readonly { beatId: string; want: string; strength: "must" | "may" }[];
  /** The classification of every request (7.3). A request with no classification is refused. */
  classifications: readonly VisualClassification[];
  voice: {
    durationMs: number;
    /** One span per beat, in script order, tiling 0 to durationMs with no gap (6.3). */
    beatSpans: readonly { beatId: string; startMs: number; endMs: number }[];
    /** The timed words of the script (6.3). A shot speaks the words that start inside it. */
    words: readonly { text: string; startMs: number; endMs: number }[];
  };
  reference: {
    durationMs: number;
    segments: readonly { segId: string; startMs: number; endMs: number; shotType: ReferenceShotType; beatRole?: BeatRole }[];
    /** The median shot length per tenth of the reference (EditGrammar.shotLengthMs.curve, 8.1). */
    shotLengthCurveMs: readonly number[];
  };
};

/** The shot-length limits of 8.3, read from configuration. */
export type ShotLengthLimits = { minMs: number; maxMs: number };
export const DEFAULT_SHOT_LENGTH: ShotLengthLimits = {
  minMs: thresholds.edit.shotLengthMinMs,
  maxMs: thresholds.edit.shotLengthMaxMs,
};

export type BeatAlignment = {
  beatId: string;
  segId: string;
  refShot: ReferenceShotType;
  /** 1 minus the distance between the beat's and the segment's relative centre, from 0 to 1. */
  score: number;
  /** The other segments the beat could have aligned to, best first. */
  alternatives: { segId: string; shotType: ReferenceShotType; score: number }[];
  /** True when no reference segment has the beat's role, so the position alone chose it. */
  byPositionOnly: boolean;
};

export type BeatSplit = {
  beatId: string;
  shotCount: number;
  /** The curve's value for the beat's place in the video, within the limits. */
  targetMs: number;
  /** The tenth of the video the beat's centre falls in. */
  curveTenth: number;
  durationsMs: number[];
};

export type AlignOutput = {
  shots: ShotInput[];
  alignments: BeatAlignment[];
  splits: BeatSplit[];
};

/** A shot id, deterministic: a sha256 digest of the request, the beat and the piece, in ULID form (like planReservationId). */
export function shotIdFor(requestId: string, beatId: string, piece: number): string {
  const digest = createHash("sha256").update(`shot|${requestId}|${beatId}|${piece}`).digest();
  const time = digest.readUIntBE(0, 6);
  const random = BigInt(`0x${digest.subarray(6, 16).toString("hex")}`);
  return `shot_${encodeUlid(time, random)}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** A span's centre as a share of its video, from 0 to 1. */
function centreOf(startMs: number, endMs: number, totalMs: number): number {
  return (startMs + endMs) / 2 / totalMs;
}

/** Checks the beat spans against the beats: one span per beat in script order, tiling the voice from 0 to its duration. */
function checkSpans(input: AlignInput): void {
  if (input.beats.length === 0) {
    throw new EngineError("invalid_input", "the plan needs at least one beat");
  }
  const ids = new Set(input.beats.map((beat) => beat.beatId));
  if (ids.size !== input.beats.length) {
    throw new EngineError("invalid_input", "beat ids must be unique");
  }
  const spans = input.voice.beatSpans;
  if (spans.length !== input.beats.length) {
    throw new EngineError("invalid_input", "the voice track needs one beat span for every beat");
  }
  let cursor = 0;
  input.beats.forEach((beat, index) => {
    const span = spans[index];
    if (span.beatId !== beat.beatId) {
      throw new EngineError("invalid_input", `the beat span of ${beat.beatId} is not in script order`);
    }
    if (span.startMs !== cursor || span.endMs <= span.startMs) {
      throw new EngineError("invalid_input", `the beat span of ${beat.beatId} leaves a gap or an overlap in the voice`);
    }
    cursor = span.endMs;
  });
  if (cursor !== input.voice.durationMs) {
    throw new EngineError("invalid_input", `the beat spans end at ${cursor} ms, not at the voice's ${input.voice.durationMs} ms`);
  }
}

/** Step 1 (6.4): the reference segment one beat aligns to. The role picks the pool; the position picks within it. */
export function alignBeat(beat: AlignBeat, span: { startMs: number; endMs: number }, input: AlignInput): BeatAlignment {
  const segments = input.reference.segments;
  const beatCentre = centreOf(span.startMs, span.endMs, input.voice.durationMs);
  const sameRole = segments.filter((segment) => segment.beatRole === beat.role);
  const pool = sameRole.length > 0 ? sameRole : segments;
  const scored = pool
    .map((segment, index) => ({
      segment,
      index,
      score: clamp01(1 - Math.abs(beatCentre - centreOf(segment.startMs, segment.endMs, input.reference.durationMs))),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0];
  return {
    beatId: beat.beatId,
    segId: best.segment.segId,
    refShot: best.segment.shotType,
    score: roundScore(best.score),
    alternatives: scored.slice(1).map((entry) => ({
      segId: entry.segment.segId,
      shotType: entry.segment.shotType,
      score: roundScore(entry.score),
    })),
    byPositionOnly: sameRole.length === 0,
  };
}

/**
 * Step 2 (6.4): how many shots a beat becomes, and their lengths. The beat's centre picks the curve's tenth, and that value is
 * the target length, held within the limits. The beat is cut into the count nearest its length over the target, never shorter
 * than the minimum or longer than the maximum, and split as evenly as whole milliseconds allow, so the pieces sum to it exactly.
 */
export function splitBeat(
  span: { beatId: string; startMs: number; endMs: number },
  voiceMs: number,
  curve: readonly number[],
  limits: ShotLengthLimits,
): BeatSplit {
  const duration = span.endMs - span.startMs;
  const curveTenth = Math.min(curve.length - 1, Math.max(0, Math.floor(curve.length * centreOf(span.startMs, span.endMs, voiceMs))));
  const targetMs = Math.min(limits.maxMs, Math.max(limits.minMs, curve[curveTenth]));
  const shortest = Math.ceil(duration / limits.maxMs);
  const most = Math.max(1, Math.floor(duration / limits.minMs));
  const wanted = Math.max(1, Math.round(duration / targetMs));
  const count = Math.min(Math.max(wanted, shortest), most);
  const base = Math.floor(duration / count);
  const extra = duration - base * count;
  const durationsMs = Array.from({ length: count }, (_, index) => (index < extra ? base + 1 : base));
  return { beatId: span.beatId, shotCount: count, targetMs, curveTenth, durationsMs };
}

/**
 * The script's words that a shot speaks: the words whose start falls inside the shot. A shot that speaks none falls back to its
 * beat's words, so a component always has text to show. Pure. Used by align (the refusals) and by the source builder.
 */
export function wordsOfShot(
  words: readonly { text: string; startMs: number }[],
  shot: { startMs: number; endMs: number },
  beatSpan: { startMs: number; endMs: number },
): string[] {
  const inside = words.filter((word) => word.startMs >= shot.startMs && word.startMs < shot.endMs).map((word) => word.text);
  if (inside.length > 0) return inside;
  return words.filter((word) => word.startMs >= beatSpan.startMs && word.startMs < beatSpan.endMs).map((word) => word.text);
}

/** The classified requests of one beat, and their texts, in request order. A request with no classification is refused. */
function requestsOf(beatId: string, input: AlignInput): { requests: ClassifiedRequest[]; wants: string[] } {
  const requests: ClassifiedRequest[] = [];
  const wants: string[] = [];
  for (const item of input.visualRequests) {
    if (item.beatId !== beatId) continue;
    const found = input.classifications.find((entry) => entry.beatId === beatId && entry.want === item.want);
    if (found === undefined) {
      throw new EngineError("invalid_input", `the request "${item.want}" on beat ${beatId} has no classification`);
    }
    requests.push({ strength: item.strength, want: item.want, properties: found.properties });
    wants.push(item.want);
  }
  return { requests, wants };
}

/** Steps 1 and 2 for the whole request: every beat aligned, split, and turned into its shots in timeline order. Pure. */
export function alignShots(input: AlignInput, limits: ShotLengthLimits = DEFAULT_SHOT_LENGTH): AlignOutput {
  checkSpans(input);
  if (input.reference.segments.length === 0) {
    throw new EngineError("invalid_input", "the plan needs at least one reference segment to align to");
  }
  if (input.reference.shotLengthCurveMs.length === 0 || input.reference.shotLengthCurveMs.some((ms) => !Number.isFinite(ms))) {
    throw new EngineError("invalid_input", "the reference shot-length curve needs finite values");
  }
  const shots: ShotInput[] = [];
  const alignments: BeatAlignment[] = [];
  const splits: BeatSplit[] = [];

  input.beats.forEach((beat, beatIndex) => {
    const span = input.voice.beatSpans[beatIndex];
    const alignment = alignBeat(beat, span, input);
    alignments.push(alignment);
    const split = splitBeat(span, input.voice.durationMs, input.reference.shotLengthCurveMs, limits);
    splits.push(split);

    const { requests, wants } = requestsOf(beat.beatId, input);
    const showsProduct = requests.some((request) => request.properties.includes("real_product"));
    const textInPixels = wants.some((want) => promptAsksForText(want).asksForText);
    const handsOnProduct = showsProduct && wants.some((want) => HANDS_REQUEST.test(want));
    const beatEmphasis = beat.emphasis ?? [];

    let cursor = span.startMs;
    split.durationsMs.forEach((durationMs, piece) => {
      const startMs = cursor;
      const endMs = cursor + durationMs;
      cursor = endMs;
      const words = wordsOfShot(input.voice.words, { startMs, endMs }, span);
      shots.push({
        shotId: shotIdFor(input.requestId, beat.beatId, piece),
        beatId: beat.beatId,
        beatRole: beat.role,
        refShot: alignment.refShot,
        startMs,
        endMs,
        flags: { textInPixels, handsOnProduct, showsProduct },
        requests,
        refusals: componentRefusals({
          durationMs,
          beatRole: beat.role,
          showsProduct,
          words,
          emphasis: emphasisIn(words, beatEmphasis),
        }),
      });
    });
  });

  return { shots, alignments, splits };
}

/** The Decisions of steps 1 and 2 (L7): every alignment and every split is logged with its reason. */
export function alignmentDecisions(output: AlignOutput): Decision[] {
  const alignments = output.alignments.map(
    (alignment): Decision => ({
      at: alignment.beatId,
      chose: alignment.refShot,
      alternatives: alignment.alternatives.map((item) => ({ option: item.shotType, score: item.score })),
      reason: alignment.byPositionOnly
        ? `Beat ${alignment.beatId} aligned to reference segment ${alignment.segId} by position: no reference segment has its role.`
        : `Beat ${alignment.beatId} aligned to reference segment ${alignment.segId} by role and relative position.`,
      by: "scorer",
    }),
  );
  const splits = output.splits.map(
    (split): Decision => ({
      at: split.beatId,
      chose: `${split.shotCount} shot${split.shotCount === 1 ? "" : "s"}`,
      alternatives: [],
      reason: `Split into ${split.shotCount} shot${split.shotCount === 1 ? "" : "s"} of about ${split.targetMs} ms, following the reference shot-length curve (tenth ${split.curveTenth}).`,
      by: "scorer",
    }),
  );
  return [...alignments, ...splits];
}
