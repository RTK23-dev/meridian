// Test helper, not production code: editor inputs built from a short description. Beats have known lengths, the voice words are
// spread evenly over each beat (the rule the fixtures use), and each media shot gets one take. Every id is a fixture id.

import {
  contentHash,
  type BeatRole,
  type BeatSpan,
  type EditGrammar,
  type ScenePlan,
  type ShotLayer,
  type ShotSpec,
  type StyleKit,
  type Take,
  type VisualType,
  type Word,
} from "../../contracts/index.ts";
import { fixtureId, FIXTURE_IDS, styleKitFixture, videoDnaFixture } from "../../contracts/fixtures/index.ts";
import type { EditInput, EditMusic, EmphasisMark } from "../editor.ts";

export type SynthBeat = { beatId: string; durationMs: number; role?: BeatRole; words?: string[] };

export type SynthShot = {
  /** The shot number. The shot id is fixtureId("shot_", n) and its take id fixtureId("take_", n). */
  n: number;
  beatId: string;
  visualType: VisualType;
  layer: ShotLayer;
  kind: "generate" | "stock" | "component";
  /** The take's length. Defaults to the shot's span. Only media shots have takes. */
  takeMs?: number;
  component?: string;
  props?: Record<string, unknown>;
};

export type SynthOptions = {
  beats: SynthBeat[];
  shots: SynthShot[];
  /** Every shot's curve value (the grammar's shot-length curve), so a test controls the fit targets. */
  curve?: number;
  grammar?: Partial<EditGrammar>;
  kit?: Partial<StyleKit>;
  /** Word spacing when the beat gives no words. Default 500 ms. */
  wordMs?: number;
  voiceLufs?: number;
  referenceDurationMs?: number;
  emphasis?: EmphasisMark[];
  music?: EditMusic;
  takes?: Take[];
  requestId?: string;
};

export const SYNTH_REQUEST_ID = FIXTURE_IDS.request;

/** The shot ids of a built input, by number, so tests can name them. */
export function shotId(n: number): string {
  return fixtureId("shot_", n);
}

export function takeId(n: number): string {
  return fixtureId("take_", n);
}

/** A grammar with a flat shot-length curve, the reference fixture's other fields, and the overrides given. */
export function synthGrammar(curve: number, overrides: Partial<EditGrammar> = {}): EditGrammar {
  return {
    ...structuredClone(videoDnaFixture.editGrammar),
    shotLengthMs: { p25: curve, p50: curve, p75: curve, curve: Array.from({ length: 10 }, () => curve) },
    ...overrides,
  };
}

function beatSpans(beats: SynthBeat[]): BeatSpan[] {
  let cursor = 0;
  return beats.map((beat) => {
    const span = { beatId: beat.beatId, startMs: cursor, endMs: cursor + beat.durationMs };
    cursor += beat.durationMs;
    return span;
  });
}

function wordsOf(beat: SynthBeat, span: BeatSpan, wordMs: number): Word[] {
  const texts = beat.words ?? Array.from({ length: Math.max(1, Math.round(beat.durationMs / wordMs)) }, (_, index) => `w${index + 1}`);
  const width = span.endMs - span.startMs;
  return texts.map((text, index) => ({
    wordId: `${beat.beatId}-${index}`,
    text,
    startMs: span.startMs + Math.round((width * index) / texts.length),
    endMs: span.startMs + Math.round((width * (index + 1)) / texts.length),
    confidence: 0.98,
  }));
}

/** The editor input for the description. The plan's shot spans are the beat spans split equally between a beat's shots. */
export function synthInput(options: SynthOptions): EditInput {
  const spans = beatSpans(options.beats);
  const wordMs = options.wordMs ?? 500;
  const words = options.beats.flatMap((beat, index) => wordsOf(beat, spans[index] as BeatSpan, wordMs));
  const durationMs = spans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0);

  const shots: ShotSpec[] = options.shots.map((shot) => {
    const span = spans.find((item) => item.beatId === shot.beatId) as BeatSpan;
    const sharing = options.shots.filter((item) => item.beatId === shot.beatId);
    const index = sharing.indexOf(shot);
    const width = (span.endMs - span.startMs) / sharing.length;
    const startMs = Math.round(span.startMs + index * width);
    const endMs = index === sharing.length - 1 ? span.endMs : Math.round(span.startMs + (index + 1) * width);
    const base = { shotId: shotId(shot.n), beatId: shot.beatId, startMs, endMs, visualType: shot.visualType, layer: shot.layer };
    if (shot.kind === "component") {
      return { ...base, source: { kind: "component", component: shot.component ?? "product.card", props: shot.props ?? { name: "Item" } } };
    }
    if (shot.kind === "stock") {
      return { ...base, source: { kind: "stock", query: "kitchen", minMs: 400 } };
    }
    return { ...base, source: { kind: "generate", modelClass: "video.budget", prompt: `shot ${shot.n}`, refs: [], takes: 1 } };
  });

  const takes =
    options.takes ??
    options.shots
      .filter((shot) => shot.kind !== "component")
      .map((shot) => {
        const planned = shots.find((item) => item.shotId === shotId(shot.n)) as ShotSpec;
        const takeDuration = shot.takeMs ?? planned.endMs - planned.startMs;
        return {
          schema: "meridian.take/v1" as const,
          takeId: takeId(shot.n),
          shotId: shotId(shot.n),
          attempt: 1,
          provider: "fixture",
          model: "fixture-model",
          uri: `store://takes/shot-${shot.n}.mp4`,
          durationMs: takeDuration,
          width: 1080,
          height: 1920,
          promptHash: contentHash(`shot ${shot.n}`),
          costUsd: 0,
          latencyMs: 1,
        };
      });

  const plan: ScenePlan = {
    schema: "meridian.scene_plan/v1",
    planId: "plan_synth",
    requestId: options.requestId ?? SYNTH_REQUEST_ID,
    videoDnaId: FIXTURE_IDS.dna,
    voiceTrackId: "vt_synth",
    shots,
    estimatedUsd: 0,
    decisions: [],
  };

  const kit: StyleKit = { ...structuredClone(styleKitFixture), ...options.kit };
  const curve = options.curve ?? 2000;

  return {
    requestId: options.requestId ?? SYNTH_REQUEST_ID,
    plan,
    voice: {
      voiceTrackId: "vt_synth",
      audioUri: "store://voice/synth.wav",
      durationMs,
      lufs: options.voiceLufs ?? -15,
      words,
      beatSpans: spans,
    },
    grammar: synthGrammar(curve, options.grammar),
    referenceDurationMs: options.referenceDurationMs ?? videoDnaFixture.durationMs,
    takes,
    kit,
    emphasis: options.emphasis ?? [],
    ...(options.music !== undefined ? { music: options.music } : {}),
  };
}
