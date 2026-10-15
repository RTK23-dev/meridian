// The EDL rules (Bible 8.3, with the checks 8.2 implies). Each rule is a named pure function: it takes the EDL and the context it
// needs, and returns one RuleResult. A rule that lacks an input it needs fails and says which input (unknown means fail, Bible 12).
// checkEdl runs them all. The pre-render gate calls checkEdl too, so the same rules hold before money is spent on a render.

import { z } from "zod";
import {
  edlSchema,
  type EditDecisionList,
  type EditGrammar,
  type EdlClip,
  type ShotSpec,
  type Take,
  type VisualType,
  type Word,
} from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { assumedFaceRect, captionBandRect, pixelBoxToRect, rectsOverlap, touchesUnsafeZone, type Rect } from "./geometry.ts";
import { insideWord } from "./words.ts";
import { FPS } from "./time.ts";
import { EDIT_TUNING, type CaptionBand } from "./tuning.ts";

/** One rule's answer. pass is the only verdict; value and limit are for the gate's log. */
export type RuleResult = {
  rule: string;
  pass: boolean;
  value?: number;
  limit?: number;
  detail?: string;
  failingShotIds?: string[];
};

/** What the rules may read beyond the EDL. A rule that needs a field the caller did not give fails and names it. */
export type RuleContext = {
  /** The voice words, our script timed (the voice track's words). */
  words?: readonly Word[];
  /** The reference grammar (caption size range). */
  grammar?: EditGrammar;
  /** The plan's shots (visual types for the run rule and the presenter exemption). */
  shots?: readonly ShotSpec[];
  /** The chosen takes (the source length each clip needs). */
  takes?: readonly Take[];
  /** The voice's duration and measured loudness, and the style kit's outro. */
  voice?: { durationMs: number; lufs: number };
  outroMs?: number;
};

/** The loop clip the editor adds for endsOnLoop (Bible 8.2 step 12). It belongs to no shot. */
export const LOOP_CLIP_ID = "loop_first";

const VISUAL_LAYERS = ["base", "cutaway", "presenter", "graphics"] as const;
type VisualLayer = (typeof VISUAL_LAYERS)[number];

/** Motion kinds that count as motion starting (Bible 8.2 step 5). */
const MOTION_EFFECTS = ["punch_in", "shake", "flash", "speed_ramp"] as const;

/** The caption component's props as the editor writes them (compose/components/captions.karaoke/props.ts). */
const captionPropsShape = z.object({
  captions: z.array(
    z.object({
      startMs: z.number(),
      endMs: z.number(),
      words: z.array(z.object({ text: z.string().min(1), startMs: z.number(), endMs: z.number() })).min(1),
    }),
  ),
  band: z.enum(["upper", "middle", "lower"]),
});

type AbsoluteCaption = { band: CaptionBand; startMs: number; endMs: number; words: { text: string; startMs: number; endMs: number }[] };

/** The shot a clip belongs to. A split part is "<shotId>-p<n>"; the loop belongs to none. */
export function shotIdOf(clipId: string): string {
  return clipId.replace(/-p\d+$/, "");
}

function result(rule: string, pass: boolean, extra: Omit<RuleResult, "rule" | "pass"> = {}): RuleResult {
  const out: RuleResult = { rule, pass };
  if (extra.value !== undefined && Number.isFinite(extra.value)) out.value = extra.value;
  if (extra.limit !== undefined && Number.isFinite(extra.limit)) out.limit = extra.limit;
  if (extra.detail !== undefined && extra.detail.length > 0) out.detail = extra.detail;
  const ids = [...new Set(extra.failingShotIds ?? [])];
  if (ids.length > 0) out.failingShotIds = ids;
  return out;
}

function missing(rule: string, input: string): RuleResult {
  return result(rule, false, { detail: `not evaluated: the rule needs ${input}, and the caller did not give it` });
}

type Visual = {
  clip: EdlClip;
  layer: VisualLayer;
  shotId: string | null;
  visualType: VisualType | null;
  presenter: boolean;
};

/** Every picture clip, in time order. Presenter shots are the ones on the presenter layer or of the ugc_presenter type. */
function visualClips(edl: EditDecisionList, ctx: RuleContext): Visual[] {
  const shots = new Map((ctx.shots ?? []).map((shot) => [shot.shotId, shot] as const));
  const visuals: Visual[] = [];
  for (const track of edl.tracks) {
    if (!(VISUAL_LAYERS as readonly string[]).includes(track.layer)) continue;
    const layer = track.layer as VisualLayer;
    for (const clip of track.clips) {
      const shotId = clip.clipId === LOOP_CLIP_ID ? null : shotIdOf(clip.clipId);
      const visualType = shotId === null ? null : (shots.get(shotId)?.visualType ?? null);
      visuals.push({ clip, layer, shotId, visualType, presenter: layer === "presenter" || visualType === "ugc_presenter" });
    }
  }
  return visuals.sort((a, b) => a.clip.startMs - b.clip.startMs || (a.clip.clipId < b.clip.clipId ? -1 : a.clip.clipId > b.clip.clipId ? 1 : 0));
}

/** Every caption of the captions track, with its band and times in the timeline (not the clip). Null when a clip is unreadable. */
function absoluteCaptions(edl: EditDecisionList): AbsoluteCaption[] | null {
  const captions: AbsoluteCaption[] = [];
  for (const track of edl.tracks) {
    if (track.layer !== "captions") continue;
    for (const clip of track.clips) {
      const parsed = captionPropsShape.safeParse(clip.props);
      if (!parsed.success) return null;
      for (const caption of parsed.data.captions) {
        captions.push({
          band: parsed.data.band,
          startMs: clip.startMs + caption.startMs,
          endMs: clip.startMs + caption.endMs,
          words: caption.words.map((word) => ({
            text: word.text,
            startMs: clip.startMs + word.startMs,
            endMs: clip.startMs + word.endMs,
          })),
        });
      }
    }
  }
  return captions.sort((a, b) => a.startMs - b.startMs);
}

/** The edit's JSON shape check (Bible 4.4). The EDL must parse against the contract before any other rule means anything. */
export function edlMatchesContract(edl: unknown): RuleResult {
  const parsed = edlSchema.safeParse(edl);
  if (parsed.success) return result("edl_matches_contract", true);
  const issue = parsed.error.issues[0];
  return result("edl_matches_contract", false, { detail: `${issue?.path.join(".") || "edl"}: ${issue?.message ?? "invalid"}` });
}

/** Bible 8.3 "No cut inside a word": no visual boundary is strictly inside a voice word. */
export function cutsOutsideWords(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "cut_outside_words";
  const words = ctx.words;
  if (words === undefined) return missing(rule, "the voice words");
  const visuals = visualClips(edl, ctx);
  const boundaries = new Map<number, string[]>();
  for (const visual of visuals) {
    for (const time of [visual.clip.startMs, visual.clip.endMs]) {
      if (time <= 0 || time >= edl.durationMs) continue;
      const shots = boundaries.get(time) ?? [];
      if (visual.shotId !== null) shots.push(visual.shotId);
      boundaries.set(time, shots);
    }
  }
  const inside = [...boundaries.entries()].filter(([time]) => insideWord(words, time));
  const failing = inside.flatMap(([, shots]) => shots);
  const limit = thresholds.edit.cutInsideWordMax;
  return result(rule, inside.length <= limit, {
    value: inside.length,
    limit,
    detail: inside.length > 0 ? `cuts inside words at ${inside.map(([time]) => `${time} ms`).join(", ")}` : undefined,
    failingShotIds: failing,
  });
}

/** Bible 8.3 "Shot length": at least 0.4 s for every shot, and at most 6 s for shots that are not presenter shots. */
export function shotLengthBounds(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "shot_length_bounds";
  const min = thresholds.edit.shotLengthMinMs;
  const max = thresholds.edit.shotLengthMaxMs;
  const breaches: { shotId: string | null; text: string }[] = [];
  for (const visual of visualClips(edl, ctx)) {
    const length = visual.clip.endMs - visual.clip.startMs;
    if (length < min) breaches.push({ shotId: visual.shotId, text: `${visual.clip.clipId} is ${length} ms, under ${min} ms` });
    if (!visual.presenter && length > max) breaches.push({ shotId: visual.shotId, text: `${visual.clip.clipId} is ${length} ms, over ${max} ms` });
  }
  return result(rule, breaches.length === 0, {
    value: breaches.length,
    limit: 0,
    detail: breaches[0]?.text,
    failingShotIds: breaches.flatMap((breach) => (breach.shotId === null ? [] : [breach.shotId])),
  });
}

/** Bible 8.3 "Caption length": every caption holds as many words as the grammar's range (the reference's caption size). */
export function captionLengthInRange(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "caption_length_in_range";
  if (ctx.grammar === undefined) return missing(rule, "the reference grammar");
  const captions = absoluteCaptions(edl);
  if (captions === null) return result(rule, false, { detail: "a caption clip has no readable props" });
  const [min, max] = ctx.grammar.captions.wordsPerCaption;
  const outside = captions.filter((caption) => caption.words.length < min || caption.words.length > max);
  return result(rule, outside.length === 0, {
    value: outside.length,
    limit: 0,
    detail: outside[0] ? `caption at ${outside[0].startMs} ms has ${outside[0].words.length} words, range ${min} to ${max}` : undefined,
  });
}

/** Bible 6.3 and 8.2 step 9: the captions carry every voice word, in order, with the same text and times. */
export function captionWordsMatchVoice(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "caption_words_match_voice";
  if (ctx.words === undefined) return missing(rule, "the voice words");
  const captions = absoluteCaptions(edl);
  if (captions === null) return result(rule, false, { detail: "a caption clip has no readable props" });
  const shown = captions.flatMap((caption) => caption.words);
  const voice = ctx.words;
  if (shown.length !== voice.length) {
    return result(rule, false, { value: shown.length, limit: voice.length, detail: `${shown.length} caption words for ${voice.length} voice words` });
  }
  const mismatch = voice.findIndex((word, index) => {
    const shownWord = shown[index];
    return shownWord === undefined || shownWord.text !== word.text || shownWord.startMs !== word.startMs || shownWord.endMs !== word.endMs;
  });
  return result(rule, mismatch === -1, {
    value: mismatch === -1 ? 0 : mismatch,
    detail: mismatch === -1 ? undefined : `caption word ${mismatch} does not match the voice word`,
  });
}

/** Bible 8.3 "Caption timing": a caption is on screen no later than its first word starts and off no earlier than its last ends. */
export function captionTiming(edl: EditDecisionList): RuleResult {
  const rule = "caption_timing";
  const captions = absoluteCaptions(edl);
  if (captions === null) return result(rule, false, { detail: "a caption clip has no readable props" });
  if (captions.length === 0) return result(rule, false, { detail: "the EDL has no captions" });
  const tolerance = thresholds.edit.captionTimingToleranceMs;
  const late = captions.filter(
    (caption) =>
      caption.words.some((word) => caption.startMs > word.startMs + tolerance || caption.endMs < word.endMs - tolerance),
  );
  return result(rule, late.length === 0, {
    value: late.length,
    limit: 0,
    detail: late[0] ? `caption at ${late[0].startMs} ms is not on screen for its words` : undefined,
  });
}

/** Bible 8.3 "Safe zones": captions and graphics stay out of the top 10%, bottom 20% and right 12% of the frame. */
export function captionsInSafeZone(edl: EditDecisionList): RuleResult {
  const rule = "captions_in_safe_zone";
  const captions = absoluteCaptions(edl);
  if (captions === null) return result(rule, false, { detail: "a caption clip has no readable props" });
  const bands = [...new Set(captions.map((caption) => caption.band))];
  const badBands = bands.filter((band) => touchesUnsafeZone(captionBandRect(band)));
  const boxes = edl.tracks
    .filter((track) => track.layer === "graphics")
    .flatMap((track) => track.clips.filter((clip) => clip.box !== undefined));
  const badBoxes = boxes.filter((clip) => clip.box !== undefined && touchesUnsafeZone(pixelBoxToRect(clip.box)));
  const failing = badBoxes.map((clip) => shotIdOf(clip.clipId));
  return result(rule, badBands.length === 0 && badBoxes.length === 0, {
    value: badBands.length + badBoxes.length,
    limit: 0,
    detail:
      badBands.length + badBoxes.length === 0
        ? undefined
        : `unsafe caption bands ${badBands.join(", ") || "none"}; graphics boxes ${badBoxes.map((clip) => clip.clipId).join(", ") || "none"}`,
    failingShotIds: failing,
  });
}

/** Bible 8.3 "Face": no caption overlaps the presenter's face box (the box, or the assumed face area when the clip has none). */
export function captionsOffPresenterFace(edl: EditDecisionList): RuleResult {
  const rule = "captions_off_presenter_face";
  const captions = absoluteCaptions(edl);
  if (captions === null) return result(rule, false, { detail: "a caption clip has no readable props" });
  const presenters = edl.tracks
    .filter((track) => track.layer === "presenter")
    .flatMap((track) => track.clips);
  const clashes: string[] = [];
  for (const caption of captions) {
    const band = captionBandRect(caption.band);
    for (const presenter of presenters) {
      const overlaps = presenter.startMs < caption.endMs && caption.startMs < presenter.endMs;
      if (!overlaps) continue;
      const face: Rect = presenter.box !== undefined ? pixelBoxToRect(presenter.box) : assumedFaceRect();
      if (rectsOverlap(band, face)) clashes.push(`${caption.band} caption at ${caption.startMs} ms over ${presenter.clipId}`);
    }
  }
  return result(rule, clashes.length === 0, {
    value: clashes.length,
    limit: 0,
    detail: clashes[0],
  });
}

/** Bible 8.2 step 11 and 8.3 "Loudness": the voice lands on the master loudness (the gain is set from its measured LUFS). */
export function voiceReachesMasterLoudness(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "voice_reaches_master_loudness";
  if (ctx.voice === undefined) return missing(rule, "the voice's measured loudness");
  const target = thresholds.postRender.loudnessTargetLufs;
  const measured = ctx.voice.lufs + edl.audio.voice.gainDb;
  const off = Math.abs(measured - target);
  return result(rule, off <= thresholds.editor.loudnessRoundingLufs.value, {
    value: measured,
    limit: target,
    detail: off <= thresholds.editor.loudnessRoundingLufs.value ? undefined : `voice lands at ${measured.toFixed(2)} LUFS, target ${target}`,
  });
}

/** The compiler plays audio up to +12 dB (compose/compiler.ts). A gain above that cannot be drawn exactly, so the EDL fails. */
export function voiceGainDrawable(edl: EditDecisionList): RuleResult {
  const rule = "voice_gain_drawable";
  const gain = edl.audio.voice.gainDb;
  const limit = thresholds.editor.maxDrawableGainDb.value;
  return result(rule, gain <= limit, { value: gain, limit, detail: gain <= limit ? undefined : `voice needs ${gain} dB, above the ${limit} dB the compiler plays` });
}

/** Bible 8.2 step 11: music sits ducked by 18 dB under speech. With no music track the rule passes and says so. */
export function musicDuckedUnderSpeech(edl: EditDecisionList): RuleResult {
  const rule = "music_ducked_under_speech";
  if (edl.audio.music === undefined) return result(rule, true, { detail: "no music track in this EDL" });
  const duck = thresholds.editor.music.duckDb;
  return result(rule, edl.audio.music.duckDb === duck, {
    value: edl.audio.music.duckDb,
    limit: duck,
    detail: edl.audio.music.duckDb === duck ? undefined : `music ducks by ${edl.audio.music.duckDb} dB, expected ${duck} dB`,
  });
}

/** The timeline is the voice plus the outro, and the voice is placed at its start (Bible 8.2 step 1, 6.8). */
export function durationMatchesClock(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "duration_matches_clock";
  if (ctx.voice === undefined || ctx.outroMs === undefined) return missing(rule, "the voice duration and the outro");
  const expected = ctx.voice.durationMs + ctx.outroMs;
  const voiceOk = edl.audio.voice.startMs === 0 && edl.audio.voice.endMs === ctx.voice.durationMs;
  const ok = edl.durationMs === expected && voiceOk;
  return result(rule, ok, {
    value: edl.durationMs,
    limit: expected,
    detail: ok ? undefined : `timeline ${edl.durationMs} ms, expected ${expected} ms; voice placed ${edl.audio.voice.startMs} to ${edl.audio.voice.endMs} ms`,
  });
}

/** Bible 8.3 "Black frames": no gap in picture longer than one frame, from the start to the end of the timeline. */
export function noBlackGaps(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "no_black_gaps";
  const spans = visualClips(edl, ctx)
    .map((visual) => [visual.clip.startMs, visual.clip.endMs] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let longest = 0;
  for (const [start, end] of spans) {
    longest = Math.max(longest, start - covered);
    covered = Math.max(covered, end);
  }
  longest = Math.max(longest, edl.durationMs - covered);
  const frames = (longest * FPS) / 1000;
  const limit = thresholds.edit.blackFramesMaxFrames;
  return result(rule, frames <= limit, {
    value: frames,
    limit,
    detail: frames <= limit ? undefined : `no picture for ${longest} ms`,
  });
}

/** Bible 8.3 "Same shot type": not more than 3 shots of one type in a row, except presenter beats. Split parts count as one shot. */
export function sameShotTypeRun(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "same_shot_type_run";
  if (ctx.shots === undefined) return missing(rule, "the plan's shots");
  const known = new Set(ctx.shots.map((shot) => shot.shotId));
  const visuals = visualClips(edl, ctx).filter((visual) => visual.shotId !== null);
  const unknown = visuals.filter((visual) => visual.shotId !== null && !known.has(visual.shotId));
  if (unknown.length > 0) {
    return result(rule, false, {
      detail: `clip ${unknown[0]?.clip.clipId ?? ""} belongs to no shot of the plan`,
      failingShotIds: unknown.flatMap((visual) => (visual.shotId === null ? [] : [visual.shotId])),
    });
  }
  const sequence: { shotId: string; type: VisualType }[] = [];
  for (const visual of visuals) {
    const shotId = visual.shotId as string;
    if (sequence[sequence.length - 1]?.shotId === shotId) continue;
    const shot = ctx.shots.find((item) => item.shotId === shotId);
    if (shot !== undefined) sequence.push({ shotId, type: shot.visualType });
  }
  const limit = thresholds.edit.sameShotTypeMaxRun;
  const failing: string[] = [];
  let run: { shotId: string; type: VisualType }[] = [];
  let worst = 0;
  const close = (): void => {
    worst = Math.max(worst, run.length);
    if (run.length > limit) failing.push(...run.map((entry) => entry.shotId));
    run = [];
  };
  for (const item of sequence) {
    if (item.type === "ugc_presenter") {
      close();
      continue;
    }
    if (run[0] !== undefined && run[0].type !== item.type) close();
    run.push(item);
  }
  close();
  return result(rule, failing.length === 0, {
    value: worst,
    limit,
    detail: failing.length === 0 ? undefined : `${failing.length} shots of one type run past ${limit}`,
    failingShotIds: failing,
  });
}

/** Bible 8.2 step 5: the hook caption is on screen by 500 ms. */
export function hookCaptionByMs(edl: EditDecisionList): RuleResult {
  const rule = "hook_caption_by_500ms";
  const captions = absoluteCaptions(edl);
  if (captions === null) return result(rule, false, { detail: "a caption clip has no readable props" });
  const first = captions[0];
  if (first === undefined) return result(rule, false, { detail: "the EDL has no captions" });
  const limit = thresholds.editor.hook.captionByMs;
  return result(rule, first.startMs <= limit, { value: first.startMs, limit });
}

/** Bible 8.2 step 5: motion starts within 300 ms, shown as a motion effect or a cut that early. */
export function hookMotionWithinMs(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "hook_motion_within_300ms";
  const limit = thresholds.editor.hook.motionWithinMs;
  const effect = edl.effects.find((item) => item.atMs <= limit && (MOTION_EFFECTS as readonly string[]).includes(item.kind));
  const cut = visualClips(edl, ctx).find((visual) => visual.clip.startMs > 0 && visual.clip.startMs <= limit);
  const at = effect !== undefined ? effect.atMs : cut?.clip.startMs;
  return result(rule, at !== undefined, {
    value: at,
    limit,
    detail: at === undefined ? "no motion effect or cut starts within the first 300 ms" : undefined,
  });
}

/** A clip cannot show more of its source than the take holds (Bible 6.7: the take gate allows 10% either way, so a clip that
 *  needs more fails here and goes back to produce_shot). */
export function sourcesCoverClips(edl: EditDecisionList, ctx: RuleContext): RuleResult {
  const rule = "sources_cover_clips";
  if (ctx.takes === undefined) return missing(rule, "the chosen takes");
  const takes = ctx.takes;
  const failing: string[] = [];
  let detail: string | undefined;
  for (const visual of visualClips(edl, ctx)) {
    const uri = visual.clip.srcUri;
    if (uri === undefined) continue;
    const needed = (visual.clip.srcInMs ?? 0) + (visual.clip.endMs - visual.clip.startMs);
    const candidates = takes.filter((take) => take.uri === uri);
    if (candidates.length === 0) {
      failing.push(...(visual.shotId === null ? [] : [visual.shotId]));
      detail ??= `${visual.clip.clipId} uses ${uri}, which is no chosen take`;
    } else if (!candidates.some((take) => take.durationMs >= needed)) {
      failing.push(...(visual.shotId === null ? [] : [visual.shotId]));
      detail ??= `${visual.clip.clipId} needs ${needed} ms of its take, which is shorter`;
    }
  }
  return result(rule, failing.length === 0, { failingShotIds: failing, detail });
}

/** Clips on one track never overlap, and every clip and effect falls inside the timeline. */
export function layoutWithinTimeline(edl: EditDecisionList): RuleResult {
  const rule = "clips_do_not_overlap_and_fit";
  const problems: string[] = [];
  for (const track of edl.tracks) {
    const clips = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    clips.forEach((clip, index) => {
      if (clip.endMs > edl.durationMs) problems.push(`${clip.clipId} ends after the timeline`);
      const previous = clips[index - 1];
      if (previous !== undefined && clip.startMs < previous.endMs) problems.push(`${previous.clipId} and ${clip.clipId} overlap on ${track.layer}`);
    });
  }
  for (const effect of edl.effects) {
    if (effect.atMs > edl.durationMs) problems.push(`effect ${effect.kind} at ${effect.atMs} ms is after the timeline`);
  }
  return result(rule, problems.length === 0, { value: problems.length, limit: 0, detail: problems[0] });
}

/** Every transition, effect and parameter is one the compiler draws (compose/compiler.ts). Anything else is refused there too. */
export function drawableByCompiler(edl: EditDecisionList): RuleResult {
  const rule = "drawable_by_compiler";
  const problems: string[] = [];
  for (const track of edl.tracks) {
    for (const clip of track.clips) {
      if (clip.transitionIn !== undefined && !(EDIT_TUNING.drawableTransitions as readonly string[]).includes(clip.transitionIn)) {
        problems.push(`${clip.clipId} uses transition ${clip.transitionIn}`);
      }
    }
  }
  for (const effect of edl.effects) {
    if (!(EDIT_TUNING.drawableEffects as readonly string[]).includes(effect.kind)) {
      problems.push(`effect ${effect.kind} is not drawn`);
      continue;
    }
    const params = effect.params;
    const allowed = effect.kind === "punch_in" ? ["scale"] : effect.kind === "flash" ? ["opacity"] : ["amplitude", "durationMs"];
    for (const key of Object.keys(params)) {
      if (!allowed.includes(key)) problems.push(`${effect.kind} does not take ${key}`);
    }
    if (effect.kind === "punch_in" && !((params.scale ?? 1.1) > 1 && (params.scale ?? 1.1) <= 1.5)) problems.push("punch_in scale is outside (1, 1.5]");
    if (effect.kind === "flash" && !((params.opacity ?? 0.8) > 0 && (params.opacity ?? 0.8) <= 1)) problems.push("flash opacity is outside (0, 1]");
  }
  return result(rule, problems.length === 0, { value: problems.length, limit: 0, detail: problems[0] });
}

/** Bible 8.3 and 12.3: true peak at or below -1 dBTP. The edit stage does not measure peaks (the voice track carries LUFS only), so
 *  the post-render review calls this with a measured value. A missing measurement fails. */
export function truePeakWithinLimit(measuredDbtp: number | undefined): RuleResult {
  const rule = "true_peak_within_limit";
  const limit = thresholds.postRender.truePeakMaxDbtp;
  if (measuredDbtp === undefined || !Number.isFinite(measuredDbtp)) {
    return result(rule, false, { detail: "not evaluated: the true peak was not measured" });
  }
  return result(rule, measuredDbtp <= limit, { value: measuredDbtp, limit });
}

/** The rules checkEdl runs, in the order the gate reports them. */
export const EDIT_RULES: readonly ((edl: EditDecisionList, ctx: RuleContext) => RuleResult)[] = [
  cutsOutsideWords,
  shotLengthBounds,
  captionLengthInRange,
  captionWordsMatchVoice,
  captionTiming,
  captionsInSafeZone,
  captionsOffPresenterFace,
  voiceReachesMasterLoudness,
  voiceGainDrawable,
  musicDuckedUnderSpeech,
  durationMatchesClock,
  noBlackGaps,
  sameShotTypeRun,
  hookCaptionByMs,
  hookMotionWithinMs,
  sourcesCoverClips,
  layoutWithinTimeline,
  drawableByCompiler,
];

export type EdlCheck = { pass: boolean; checks: RuleResult[]; failingShotIds: string[] };

/**
 * Validates an EDL against the contract and every rule. Pure. An input that does not parse fails at the first check and runs no
 * other rule. The pass is true only with at least one check and every check passing.
 */
export function checkEdl(input: unknown, ctx: RuleContext): EdlCheck {
  const contract = edlMatchesContract(input);
  if (!contract.pass) return { pass: false, checks: [contract], failingShotIds: [] };
  const edl = edlSchema.parse(input);
  const checks = [contract, ...EDIT_RULES.map((rule) => rule(edl, ctx))];
  const failingShotIds = [...new Set(checks.flatMap((check) => check.failingShotIds ?? []))];
  return { pass: checks.every((check) => check.pass), checks, failingShotIds };
}

