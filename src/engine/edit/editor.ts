// The deterministic editor (Bible 8.2): the scene plan, the chosen takes, the voice track, the reference grammar and the style kit
// go in; an EditDecisionList and its check results come out. Pure: no model call, no clock, no environment. The same input gives
// the same EDL and content hash, because every free choice draws from a generator seeded by the request id.
//
// The steps are in the order of Bible 8.2. Step 1 is the clock, step 2 places the shots, step 3 snaps the cuts, step 4 merges
// and splits, step 5 cuts the hook, steps 6 and 10 place the punch-ins, step 7 is J and L cuts (not measured by the grammar, so
// none are made), step 8 is the layer stack, step 9 the captions, step 11 the sound, step 12 the loop, and step 13 the seed.
// A violation of 8.3 that the steps cannot fix fails the edit gate (checkEdl), with the shots it names.

import {
  contentHash,
  EngineError,
  edlSchema,
  encodeUlid,
  type BeatSpan,
  type EditDecisionList,
  type EditGrammar,
  type EdlClip,
  type ScenePlan,
  type StyleKit,
  type Take,
  type Word,
} from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { checkEdl, LOOP_CLIP_ID, type RuleResult } from "./rules.ts";
import { captionBreaks, emphasisStarts, groupWords, snapCut, type SnapContext } from "./words.ts";
import { createRng, pickWeighted, seedFromRequestId, type Rng } from "./prng.ts";
import { shotTargetMs } from "./time.ts";
import { EDIT_TUNING, type CaptionBand } from "./tuning.ts";
import { MIN_SHOT_MS, mergeShortPieces, placeShots, snapBoundaries, splitHook, splitLongPieces, type Piece } from "./pieces.ts";

/** One emphasis mark from the script: a beat and a term. Claude's intent marks, copied from the request (Bible 8.2). */
export type EmphasisMark = { beatId: string; term: string };

/** A music track placed under the speech. bpm is the track's own tempo; without it cuts are not snapped to beats. */
export type EditMusic = { uri: string; durationMs: number; bpm?: number };

export type EditInput = {
  requestId: string;
  plan: ScenePlan;
  voice: { voiceTrackId: string; audioUri: string; durationMs: number; lufs: number; words: Word[]; beatSpans: BeatSpan[] };
  grammar: EditGrammar;
  /** The reference video's duration. The hook cut is scaled by our timeline over this. */
  referenceDurationMs: number;
  /** The chosen take of each generated or stock shot. A shot with no take must be a component. */
  takes: Take[];
  kit: StyleKit;
  emphasis: EmphasisMark[];
  music?: EditMusic;
};

export type EditBuild = {
  edlId: string;
  seed: number;
  inputHash: string;
  /** The EDL when it parses against the contract, else null. A failing EDL is never stored (the stage writes nothing on a fail). */
  edl: EditDecisionList | null;
  /** True only when every precondition and every rule passes. */
  pass: boolean;
  checks: RuleResult[];
  failingShotIds: string[];
  /** What the editor did and what it could not place, in plain words (Bible 6.8). */
  notes: string[];
};

type Effect = EditDecisionList["effects"][number];
type Transition = { transition: string | null; effect: "flash" | "punch_in" | null };

const VISUAL_TRACK_ORDER = ["base", "cutaway", "presenter", "graphics"] as const;

/** The loudness target the edit sets the voice to (Bible 8.3), read from configuration. */
const MASTER_LUFS = thresholds.postRender.loudnessTargetLufs;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundDb(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The identity of one edit run: the sha256 of its inputs and the EDL id made from the first 80 bits of that hash. The same inputs
 * always give the same id, so a repeated job names the same EDL (Bible 5.1 idempotency). The id is an edl_ ULID with a zero time part.
 */
export function editIdentity(parts: unknown): { inputHash: string; edlId: string } {
  const inputHash = contentHash(parts);
  const hex = inputHash.slice("sha256:".length, "sha256:".length + 20);
  return { inputHash, edlId: `edl_${encodeUlid(0, BigInt(`0x${hex}`))}` };
}

type Preconditions = {
  ok: boolean;
  checks: RuleResult[];
  failingShotIds: string[];
  beats: BeatSpan[];
  takes: Map<string, Take>;
  captionRanges: Array<[number, number]>;
};

/** Inputs that must hold before anything is placed. A failing one is a check with a detail, and no EDL is built. */
function preconditions(input: EditInput): Preconditions {
  const checks: RuleResult[] = [];
  const failing: string[] = [];
  const add = (rule: string, pass: boolean, detail?: string, shots: string[] = []): void => {
    checks.push(detail === undefined ? { rule, pass } : { rule, pass, detail });
    if (!pass) failing.push(...shots);
  };
  const { voice, plan, grammar, kit } = input;
  const beats = [...voice.beatSpans].sort((a, b) => a.startMs - b.startMs);

  // The beats must tile the voice from 0 to its end with no gap or overlap (Bible 6.3).
  let tiles = beats.length > 0 && beats[0]?.startMs === 0 && beats[beats.length - 1]?.endMs === voice.durationMs;
  for (let index = 1; index < beats.length; index += 1) {
    if (beats[index]?.startMs !== beats[index - 1]?.endMs) tiles = false;
  }
  add("voice_beats_tile_voice", tiles, tiles ? undefined : "the voice beat spans do not run from 0 to the voice end without a gap");

  // Words must be in order, not overlapping, and inside the voice.
  const words = voice.words;
  const ordered = words.every((word, index) => word.startMs < word.endMs && word.endMs <= voice.durationMs && (index === 0 || word.startMs >= (words[index - 1]?.endMs ?? 0)));
  add("voice_words_in_order", ordered, ordered ? undefined : "the voice words overlap, run backwards or pass the voice end");

  add(
    "caption_range_drawable",
    grammar.captions.wordsPerCaption[1] <= EDIT_TUNING.captions.maxWordsPerCaption,
    `the captions component draws up to ${EDIT_TUNING.captions.maxWordsPerCaption} words a caption`,
  );

  const karaoke = kit.captionStyle.component === "captions.karaoke";
  add("style_kit_drawable", karaoke, karaoke ? undefined : `the style kit names ${kit.captionStyle.component}, which the editor does not place`);

  // Each take belongs to a shot that takes media, and each such shot has exactly one take.
  const takes = new Map<string, Take>();
  const takeProblems: string[] = [];
  const mediaShots = new Set(plan.shots.filter((shot) => shot.source.kind === "generate" || shot.source.kind === "stock").map((shot) => shot.shotId));
  for (const take of input.takes) {
    if (!mediaShots.has(take.shotId)) {
      takeProblems.push(take.shotId);
      continue;
    }
    if (takes.has(take.shotId)) {
      takeProblems.push(take.shotId);
      continue;
    }
    takes.set(take.shotId, take);
  }
  add("takes_match_plan", takeProblems.length === 0, takeProblems.length === 0 ? undefined : "a take names no media shot of the plan, or a shot has two takes", takeProblems);

  const beatIds = new Set(beats.map((beat) => beat.beatId));
  const unnamed = plan.shots.filter((shot) => !beatIds.has(shot.beatId)).map((shot) => shot.shotId);
  add("shots_name_voice_beats", unnamed.length === 0, unnamed.length === 0 ? undefined : "a shot names a beat the voice does not have", unnamed);

  const uncovered = beats.filter((beat) => !plan.shots.some((shot) => shot.beatId === beat.beatId)).map((beat) => beat.beatId);
  add("every_beat_has_shot", uncovered.length === 0, uncovered.length === 0 ? undefined : `beats with no shot: ${uncovered.join(", ")}`);

  const sourceless: string[] = [];
  const sourceProblems: string[] = [];
  for (const shot of plan.shots) {
    if (shot.source.kind === "asset") {
      sourceProblems.push(shot.shotId);
    } else if ((shot.source.kind === "generate" || shot.source.kind === "stock") && !takes.has(shot.shotId)) {
      sourceless.push(shot.shotId);
    }
  }
  const sourceFailing = [...sourceless, ...sourceProblems];
  const sourceDetail =
    sourceless.length > 0
      ? `no chosen take for ${sourceless.join(", ")}`
      : sourceProblems.length > 0
        ? "an existing asset has no duration in the inputs, so the editor cannot check it covers its clip"
        : undefined;
  add("shot_sources_available", sourceFailing.length === 0, sourceDetail, sourceFailing);

  const captionRanges = groupWords(captionBreaks(words, beats), {
    min: grammar.captions.wordsPerCaption[0],
    max: grammar.captions.wordsPerCaption[1],
  });
  add(
    "captions_grouped_in_range",
    captionRanges !== null,
    captionRanges === null
      ? `the ${words.length} voice words cannot be split into captions of ${grammar.captions.wordsPerCaption[0]} to ${grammar.captions.wordsPerCaption[1]} words`
      : undefined,
  );

  if (input.music !== undefined) {
    const total = voice.durationMs + kit.outroMs;
    add("music_covers_timeline", input.music.durationMs >= total, `the music is ${input.music.durationMs} ms, the timeline ${total} ms`);
  }

  return {
    ok: checks.every((check) => check.pass),
    checks,
    failingShotIds: [...new Set(failing)],
    beats,
    takes,
    captionRanges: captionRanges ?? [],
  };
}

/** The punch-in scale for one effect: the grammar's amplitude scaled by motion intensity, with a seeded jitter (Bible 8.2 step 10). */
function punchScale(rng: Rng, grammar: EditGrammar, intensity: number): number {
  const full = Math.max(grammar.motion.punchInScale, EDIT_TUNING.punch.minScale);
  const base = 1 + ((full - 1) * (intensity + 1)) / EDIT_TUNING.punch.intensityDivisor;
  const jitter = 1 + EDIT_TUNING.punch.jitterShare * (2 * rng.next() - 1);
  const scale = Math.min(Math.max(base * jitter, EDIT_TUNING.punch.floorScale), EDIT_TUNING.punch.maxScale);
  return round3(scale);
}

/** The transitions the grammar's mix can draw, each mapped to what the compiler draws. Kinds it cannot draw are listed, not guessed. */
function transitionMix(grammar: EditGrammar, intensity: number, notes: string[]): { value: Transition; weight: number }[] {
  const items: { value: Transition; weight: number }[] = [];
  const skipped: string[] = [];
  for (const entry of grammar.transitions) {
    const weight = entry.share;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (entry.kind === "hard") items.push({ value: { transition: "hard", effect: null }, weight });
    else if (entry.kind === "fade") items.push({ value: { transition: "fade", effect: null }, weight });
    else if (entry.kind === "whip" && intensity > 0) items.push({ value: { transition: "whip", effect: null }, weight });
    else if (entry.kind === "flash" && intensity > 0) items.push({ value: { transition: "hard", effect: "flash" }, weight });
    else if (entry.kind === "zoom" && intensity > 0) items.push({ value: { transition: "hard", effect: "punch_in" }, weight });
    else skipped.push(entry.kind);
  }
  if (skipped.length > 0) notes.push(`transition kinds not placed (the compiler does not draw them, or the motion intensity is 0): ${skipped.join(", ")}`);
  return items.length > 0 ? items : [{ value: { transition: "hard", effect: null }, weight: 1 }];
}

/** Adds an optional punch-in unless another effect is within the clash distance (Bible 8.2 steps 6 and 10). */
function addOptional(effects: Effect[], atMs: number, rng: Rng, grammar: EditGrammar, intensity: number): void {
  if (effects.some((effect) => Math.abs(effect.atMs - atMs) < EDIT_TUNING.effectClashMs)) return;
  effects.push({ atMs, kind: "punch_in", params: { scale: punchScale(rng, grammar, intensity) } });
}

/** The nearest emphasis start within half the re-hook interval, else the interval point itself (Bible 8.2 step 6). */
function rehookTime(point: number, emphasis: readonly number[], halfWindow: number): number {
  let best: number | null = null;
  for (const start of emphasis) {
    if (Math.abs(start - point) > halfWindow) continue;
    if (best === null || Math.abs(start - point) < Math.abs(best - point)) best = start;
  }
  return best ?? point;
}

/** Builds the EDL for one request. Pure and deterministic: the same input gives the same result (Bible 8.2). */
export function buildEdl(input: EditInput): EditBuild {
  const { inputHash, edlId } = editIdentity({ tuning: EDIT_TUNING.version, input });
  const seed = seedFromRequestId(input.requestId);
  const notes: string[] = [];
  const pre = preconditions(input);
  if (!pre.ok) {
    return { edlId, seed, inputHash, edl: null, pass: false, checks: pre.checks, failingShotIds: pre.failingShotIds, notes };
  }

  const { voice, grammar, kit, plan } = input;
  const total = voice.durationMs + kit.outroMs;
  const intensity = kit.motionIntensity;
  const rng = createRng(seed);
  const beatPeriodMs = input.music?.bpm !== undefined && input.music.bpm > 0 ? 60_000 / input.music.bpm : undefined;
  if (input.music !== undefined && beatPeriodMs === undefined) notes.push("music has no bpm, so cuts are not snapped to its beat");
  const snap: SnapContext = { words: voice.words, beatPeriodMs };
  const targetAt = (midMs: number): number => shotTargetMs(grammar.shotLengthMs.curve, midMs, total);

  // Steps 2 to 5: place, snap, merge, cut the hook, split.
  let pieces: Piece[] = placeShots(plan, pre.beats, pre.takes);
  const last = pieces[pieces.length - 1];
  if (last !== undefined) last.endMs = total;
  snapBoundaries(pieces, snap);
  pieces = mergeShortPieces(pieces, targetAt, notes);
  const hookTarget = Math.round((grammar.hookFirstCutMs * total) / input.referenceDurationMs);
  pieces = splitHook(pieces, hookTarget, snap, notes);
  pieces = splitLongPieces(pieces, targetAt, snap, notes);
  pieces.sort((a, b) => a.startMs - b.startMs);

  // Steps 6 and 10: the transition at every cut, then the punch-ins.
  const mix = transitionMix(grammar, intensity, notes);
  const effects: Effect[] = [];
  const transitionAt = new Map<number, string>();
  for (const piece of pieces.slice(1)) {
    const choice = pickWeighted(rng, mix);
    if (choice.transition !== null) transitionAt.set(piece.startMs, choice.transition);
    if (choice.effect === "flash") effects.push({ atMs: piece.startMs, kind: "flash", params: {} });
    if (choice.effect === "punch_in") effects.push({ atMs: piece.startMs, kind: "punch_in", params: { scale: punchScale(rng, grammar, intensity) } });
  }
  effects.push({ atMs: 0, kind: "punch_in", params: { scale: punchScale(rng, grammar, intensity) } });
  for (const piece of pieces) {
    if (piece.splitStart) effects.push({ atMs: piece.startMs, kind: "punch_in", params: { scale: punchScale(rng, grammar, intensity) } });
  }
  const emphasis = emphasisStarts(voice.words, pre.beats, input.emphasis);
  for (const start of emphasis) addOptional(effects, start, rng, grammar, intensity);
  const interval = grammar.rehookIntervalMs;
  for (let point = interval; point < total; point += interval) {
    addOptional(effects, rehookTime(point, emphasis, interval / 2), rng, grammar, intensity);
  }
  effects.sort((a, b) => a.atMs - b.atMs || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // Step 9: captions. A caption starts with its first word (the first one by the hook's deadline) and ends with its last word.
  // A caption over a presenter's shot sits in the lower band, off the assumed face area.
  const captions = (pre.captionRanges ?? []).map(([first, end], index) => {
    const startWord = voice.words[first];
    const endWord = voice.words[end - 1];
    if (startWord === undefined || endWord === undefined) {
      throw new EngineError("internal", "a caption range falls outside the voice words", { stage: "edit" });
    }
    const startMs = index === 0 ? Math.min(startWord.startMs, EDIT_TUNING.hook.captionByMs) : startWord.startMs;
    const endMs = endWord.endMs;
    const overPresenter = pieces.some((piece) => piece.layer === "presenter" && piece.startMs < endMs && startMs < piece.endMs);
    const band: CaptionBand = overPresenter ? "lower" : grammar.captions.position;
    const words = voice.words.slice(first, end).map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs }));
    return { startMs, endMs, band, words };
  });
  const captionClips: EdlClip[] = [];
  let group: typeof captions = [];
  const flush = (): void => {
    const first = group[0];
    const lastCaption = group[group.length - 1];
    if (first === undefined || lastCaption === undefined) return;
    captionClips.push({
      clipId: `captions-${captionClips.length + 1}`,
      startMs: first.startMs,
      endMs: lastCaption.endMs,
      component: "captions.karaoke",
      props: {
        band: first.band,
        captions: group.map((caption) => ({
          startMs: caption.startMs - first.startMs,
          endMs: caption.endMs - first.startMs,
          words: caption.words.map((word) => ({
            text: word.text,
            startMs: word.startMs - first.startMs,
            endMs: word.endMs - first.startMs,
          })),
        })),
      },
    });
    group = [];
  };
  for (const caption of captions) {
    const head = group[0];
    if (head !== undefined && (head.band !== caption.band || group.length >= EDIT_TUNING.captions.maxPerClip)) flush();
    group.push(caption);
  }
  flush();

  // Step 12: the loop. The last loopMs cross-fade to the first frame, drawn as a clip of the first take on the cutaway layer.
  const loopClips: EdlClip[] = [];
  if (grammar.endsOnLoop) {
    const first = pieces[0];
    const loopStart = snapCut(total - EDIT_TUNING.loopMs, { lo: 1, hi: total - MIN_SHOT_MS }, snap);
    const cutawayBusy = pieces.some((piece) => piece.layer === "cutaway" && piece.endMs > loopStart);
    if (first === undefined || first.media === null) {
      notes.push("loop skipped: the first shot is a component, so it has no first frame to return to");
    } else if (cutawayBusy) {
      notes.push("loop skipped: the cutaway layer is in use at the end");
    } else {
      loopClips.push({
        clipId: LOOP_CLIP_ID,
        startMs: loopStart,
        endMs: total,
        srcUri: first.media.uri,
        srcInMs: 0,
        transitionIn: "fade",
      });
      notes.push("loop: the first frame cross-fades at the end (the compiler's fade is 200 ms, not the grammar's 500 ms)");
    }
  }

  // Step 8: the layer stack. Shot ids name the clips; a split part is "<shotId>-p<n>".
  const counts = new Map<string, number>();
  const clipFor = (piece: Piece, transitionIn: string | null): EdlClip => {
    const seen = counts.get(piece.shotId) ?? 0;
    counts.set(piece.shotId, seen + 1);
    const clipId = seen === 0 ? piece.shotId : `${piece.shotId}-p${seen}`;
    const base: EdlClip = { clipId, startMs: piece.startMs, endMs: piece.endMs };
    if (transitionIn !== null) base.transitionIn = transitionIn;
    if (piece.media !== null) return { ...base, srcUri: piece.media.uri, srcInMs: piece.media.srcInMs };
    return { ...base, component: piece.component?.name ?? "", props: piece.component?.props ?? {} };
  };
  const tracks: EditDecisionList["tracks"] = [];
  for (const layer of VISUAL_TRACK_ORDER) {
    const clips = pieces
      .filter((piece) => piece.layer === layer)
      .map((piece) => clipFor(piece, piece.startMs === 0 ? null : (transitionAt.get(piece.startMs) ?? null)));
    if (layer === "cutaway") clips.push(...loopClips);
    clips.sort((a, b) => a.startMs - b.startMs);
    if (clips.length > 0) tracks.push({ layer, clips });
  }
  if (captionClips.length > 0) tracks.push({ layer: "captions", clips: captionClips });

  // Step 11: the sound. The voice is set to the master loudness from its measured LUFS. Music sits ducked under speech.
  const audio: EditDecisionList["audio"] = {
    voice: { uri: voice.audioUri, startMs: 0, endMs: voice.durationMs, gainDb: roundDb(MASTER_LUFS - voice.lufs) },
    sfx: [],
    masterLufs: -14,
  };
  if (input.music !== undefined) {
    audio.music = {
      uri: input.music.uri,
      startMs: 0,
      endMs: total,
      gainDb: EDIT_TUNING.music.baseGainDb,
      duckDb: EDIT_TUNING.music.duckDb,
    };
  } else if (grammar.sound.music) {
    notes.push("no music track was supplied, so the EDL has no music (the reference has music)");
  }
  notes.push("J and L cuts: the grammar does not measure them, so every cut is a hard cut or a sampled transition");
  if (grammar.sound.sfxPer10s > 0) notes.push("sound effects: no sound effect source in the inputs, so none are placed");
  if (grammar.motion.speedRamps) notes.push("speed ramps: the compiler does not draw speed_ramp, so none are placed");
  if (grammar.sound.silenceBeforePayoffMs !== undefined) {
    notes.push("silence before the payoff is a voice-stage pacing mark; the editor does not move the voice clock");
  }

  const candidate = {
    schema: "meridian.edl/v1",
    edlId,
    requestId: input.requestId,
    durationMs: total,
    fps: 30,
    width: 1080,
    height: 1920,
    tracks,
    audio,
    effects,
    seed,
  };
  const parsed = edlSchema.safeParse(candidate);
  const edl = parsed.success ? parsed.data : null;
  const ctx = {
    words: voice.words,
    grammar,
    shots: plan.shots,
    takes: input.takes,
    voice: { durationMs: voice.durationMs, lufs: voice.lufs },
    outroMs: kit.outroMs,
  };
  const verdict = checkEdl(candidate, ctx);
  return {
    edlId,
    seed,
    inputHash,
    edl,
    pass: pre.ok && verdict.pass,
    checks: [...pre.checks, ...verdict.checks],
    failingShotIds: [...new Set([...pre.failingShotIds, ...verdict.failingShotIds])],
    notes,
  };
}
