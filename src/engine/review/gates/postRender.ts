// The post_render gate (Bible 6.12, 12.3). It judges the actual MP4 against the EDL it was rendered from. Pure: every measurement is
// passed in as data (the media functions and the Critic are called by the stage handler), and the gate never reads a store or the
// network. It returns the GateResult the orchestrator routes, and the review result's failures (the shot or layer at fault).
//
// Checks: the render integrity result for this video (from the render stage), loudness, true peak, silence, every graphics overlay
// drawn in its frame, black frames at the cut and sample frames, OCR of the captions against the script, forbidden terms on screen,
// and the final Critic's rubric and confidence (criticFinal.ts). A check whose evidence is missing fails with "not evaluated"; a
// missing measurement is never a pass (Bible 12). A broken overlay fails here, so it cannot reach delivery.

import { thresholds } from "../../config/thresholds.ts";
import {
  edlSchema,
  gateResultSchema,
  idSchema,
  renderedVideoSchema,
  type EdlLayer,
  type EditDecisionList,
  type GateCheck,
  type GateResult,
} from "../../contracts/index.ts";
import { shotIdOf, truePeakWithinLimit } from "../../edit/rules.ts";
import { FINAL_RUBRIC_ITEMS } from "../../claude/roles/critic_final.ts";
import { check, asShotIds, EDL_FPS, gateResult, notEvaluated, stringsIn } from "./common.ts";
import type { CriticFinalOutcome } from "../criticFinal.ts";
import type { GoldMetrics } from "../gold.ts";
import { checkKey } from "../gold.ts";

export const POST_RENDER_GATE = "post_render";
/** The one gold set for the final Critic's rubric (Bible 12.4: one per Claude check). Every rubric check reads it. */
export const CRITIC_FINAL_GOLD_KEY = "post_render:critic_final";
const VISUAL_LAYERS = ["base", "cutaway", "presenter", "graphics"] as const;

/** One graphics clip's overlay, as the frames show it. present null means the frame could not say. */
export type OverlayMeasurement = { clipId: string; present: boolean | null };
/** Whether the frame at atMs is black. black null means the frame could not be measured. */
export type BlackFrameMeasurement = { atMs: number; black: boolean | null };
/** OCR of the captions against the script, and the text read from the screen. */
export type OcrMeasurement = { captionWordsChecked: number; captionWordsMismatched: number; onScreenText: string[] };
/** EBU R128 loudness and the true peak of the MP4 (media loudness). null means not measurable. */
export type LoudnessMeasurement = { integratedLufs: number | null; truePeakDbtp: number | null };
/** The longest silence in the MP4 (media timeline), or null when it cannot be measured. */
export type SilenceMeasurement = { longestMs: number | null };

export type PostRenderInput = {
  /** The rendered video (rendered_video artifact). Parsed here. */
  renderedVideo: unknown;
  /** The EDL it was rendered from (edl artifact). Parsed here. */
  edl: unknown;
  /** The render stage's render_integrity GateResult for this video, when the stage passed it on. Undefined: no evidence. */
  integrity: unknown | undefined;
  loudness: LoudnessMeasurement | undefined;
  silence: SilenceMeasurement | undefined;
  overlays: readonly OverlayMeasurement[] | undefined;
  blackFrames: readonly BlackFrameMeasurement[] | undefined;
  ocr: OcrMeasurement | undefined;
  /** The forbidden terms of the product kit (Bible 13). Undefined when the kit's terms are not known. */
  forbiddenTerms: readonly string[] | undefined;
  /** The final Critic's outcome (criticFinal.ts). */
  critic: CriticFinalOutcome;
};

/** One reviewer-facing failure: the rule, and the shot or layer at fault when one is known (Bible 12.5, review_result). */
export type ReviewFailure = { rule: string; shotId?: string; layer?: EdlLayer };

export type PostRenderOutcome = {
  gate: GateResult;
  /** Every failing check, with the shot or layer it names. Empty only when the gate passes. */
  failures: ReviewFailure[];
};

/** Bible 12.3 "frames at every cut ± 2 frames and at 10%, 35%, 65% and 90%": the times the frame measurements must cover. */
export function requiredFrameTimes(edl: Pick<EditDecisionList, "durationMs" | "tracks">): number[] {
  const frameMs = 1000 / EDL_FPS;
  const window = thresholds.postRender.cutFrameWindow;
  const last = edl.durationMs - 1;
  const clamp = (time: number): number => Math.min(Math.max(Math.round(time), 0), last);
  const times = new Set<number>();
  for (const position of thresholds.postRender.samplePositions) {
    times.add(clamp(position * edl.durationMs));
  }
  for (const boundary of cutBoundaries(edl)) {
    for (let offset = -window; offset <= window; offset++) {
      times.add(clamp(boundary + offset * frameMs));
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Every start and end of a picture clip: the cuts (Bible 8.2). */
function cutBoundaries(edl: Pick<EditDecisionList, "tracks">): number[] {
  const boundaries = new Set<number>();
  for (const track of edl.tracks) {
    if (!(VISUAL_LAYERS as readonly string[]).includes(track.layer)) continue;
    for (const clip of track.clips) {
      boundaries.add(clip.startMs);
      boundaries.add(clip.endMs);
    }
  }
  return [...boundaries].sort((a, b) => a - b);
}

/** The twelve frames the final Critic sees: evenly spaced over the whole video (Bible 11.1), each at the middle of its slot. */
export function criticFrameTimes(durationMs: number): number[] {
  const count = thresholds.postRender.criticFinalFrames;
  if (!Number.isInteger(durationMs) || durationMs < count) return [];
  return Array.from({ length: count }, (_, index) => Math.floor(((index + 0.5) * durationMs) / count));
}

/** The shot a point of the timeline belongs to, from the picture clips. Null when no shot covers it. */
export function shotAt(edl: Pick<EditDecisionList, "tracks">, atMs: number): string | null {
  for (const track of edl.tracks) {
    if (!(VISUAL_LAYERS as readonly string[]).includes(track.layer)) continue;
    for (const clip of track.clips) {
      if (clip.startMs <= atMs && atMs < clip.endMs) {
        const id = shotIdOf(clip.clipId);
        return idSchema("shot_").safeParse(id).success ? id : null;
      }
    }
  }
  return null;
}

function shotIdIfAny(clipId: string): string | undefined {
  const id = shotIdOf(clipId);
  return idSchema("shot_").safeParse(id).success ? id : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the term appears as whole words in the text, in any case. Terms and text are both lower-cased here. */
export function containsTerm(text: string, term: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}($|[^a-z0-9])`);
  return pattern.test(text.toLowerCase());
}

/** The text the EDL puts on screen: the caption words and every string a clip's props carry (titles, prices, names). */
export function onScreenTextOf(edl: EditDecisionList): string[] {
  const texts: string[] = [];
  for (const track of edl.tracks) {
    for (const clip of track.clips) {
      texts.push(...stringsIn(clip.props));
    }
  }
  return texts;
}

/** The rule names of this gate, in the order the gate reports them. */
export const POST_RENDER_RULE_NAMES = [
  "render_integrity_passed",
  "loudness_within_tolerance",
  "true_peak_within_limit",
  "silence_within_limit",
  "overlays_present",
  "black_frames_absent",
  "captions_ocr_match_script",
  "forbidden_terms_absent",
  "critic_final_answered",
  ...FINAL_RUBRIC_ITEMS.map((item) => `rubric_${item}`),
  "critic_confidence",
] as const;

function schemaFailure(detail: string): GateResult {
  return gateResult(POST_RENDER_GATE, "video:unparsed", [
    check("schema_valid", false, { detail }),
    notEvaluated("render_integrity_passed", "an input does not parse"),
  ]);
}

/** Judges one rendered video. Returns the gate result and the failures the review result records. */
export function checkPostRender(input: PostRenderInput): PostRenderOutcome {
  const renderedParsed = renderedVideoSchema.safeParse(input.renderedVideo);
  const edlParsed = edlSchema.safeParse(input.edl);
  if (!renderedParsed.success || !edlParsed.success) {
    const parts: string[] = [];
    if (!renderedParsed.success) parts.push(`rendered video: ${renderedParsed.error.message}`);
    if (!edlParsed.success) parts.push(`edl: ${edlParsed.error.message}`);
    return { gate: schemaFailure(parts.join("; ")), failures: [{ rule: "schema_valid" }] };
  }
  const rendered = renderedParsed.data;
  const edl = edlParsed.data;
  const checks: GateCheck[] = [];
  const attributed = new Map<string, Array<{ shotId?: string; layer?: EdlLayer }>>();
  const attribute = (rule: string, ...items: Array<{ shotId?: string; layer?: EdlLayer }>): void => {
    attributed.set(rule, [...(attributed.get(rule) ?? []), ...items]);
  };
  const failingShotIds: string[] = [];

  // 1. The render integrity result for this video, from the render stage (Bible 6.11). Missing evidence is not a pass.
  if (input.integrity === undefined) {
    checks.push(notEvaluated("render_integrity_passed", "no render_integrity result for this video reached the review (missing evidence)"));
  } else {
    const parsed = gateResultSchema.safeParse(input.integrity);
    if (!parsed.success) {
      checks.push(check("render_integrity_passed", false, { detail: "the render_integrity result does not parse" }));
    } else if (parsed.data.gate !== "render_integrity" || parsed.data.subjectId !== rendered.videoId) {
      checks.push(check("render_integrity_passed", false, { detail: "the render_integrity result is for another render" }));
    } else {
      const failed = parsed.data.checks.filter((item) => !item.pass).map((item) => item.rule);
      checks.push(
        check("render_integrity_passed", parsed.data.pass, {
          detail: parsed.data.pass ? undefined : `render integrity failed: ${failed.join(", ")}`,
        }),
      );
    }
  }

  // 2. Loudness: -14 LUFS within the tolerance (Bible 8.2 step 11, 12.3).
  const target = thresholds.postRender.loudnessTargetLufs;
  const tolerance = thresholds.postRender.loudnessToleranceLufs.value;
  const lufs = input.loudness?.integratedLufs;
  if (lufs === undefined || lufs === null) {
    checks.push(notEvaluated("loudness_within_tolerance", "the integrated loudness was not measured"));
  } else {
    checks.push(
      check("loudness_within_tolerance", Math.abs(lufs - target) <= tolerance, {
        value: lufs,
        limit: target,
        detail: `${lufs} LUFS against ${target} plus or minus ${tolerance}`,
      }),
    );
  }

  // 3. True peak at or below -1 dBTP, which also rules out clipping (Bible 12.3). The edit rule judges the number.
  const peakRule = truePeakWithinLimit(input.loudness?.truePeakDbtp ?? undefined);
  checks.push(check(peakRule.rule, peakRule.pass, { value: peakRule.value, limit: peakRule.limit, detail: peakRule.detail }));

  // 4. No silence over the limit outside planned silences (Bible 12.3).
  const silenceLimit = thresholds.postRender.silenceMaxMs.value;
  const longest = input.silence?.longestMs;
  if (longest === undefined || longest === null) {
    checks.push(notEvaluated("silence_within_limit", "the silence was not measured"));
  } else {
    checks.push(
      check("silence_within_limit", longest <= silenceLimit, {
        value: longest,
        limit: silenceLimit,
        detail: `longest silence ${longest} ms against ${silenceLimit} ms`,
      }),
    );
  }

  // 5. Every graphics overlay in the EDL appears in its frame (Bible 12.3: a broken overlay never reaches delivery).
  const graphics = edl.tracks.filter((track) => track.layer === "graphics").flatMap((track) => track.clips);
  if (graphics.length === 0) {
    checks.push(check("overlays_present", true, { detail: "the EDL has no graphics layer" }));
  } else if (input.overlays === undefined) {
    checks.push(notEvaluated("overlays_present", `no overlay measurement reached the review for ${graphics.length} graphics clip(s)`));
    for (const clip of graphics) attribute("overlays_present", { layer: "graphics", shotId: shotIdIfAny(clip.clipId) });
  } else {
    const measured = new Map(input.overlays.map((item) => [item.clipId, item.present] as const));
    const broken = graphics.filter((clip) => measured.get(clip.clipId) === false);
    const unknown = graphics.filter((clip) => {
      const value = measured.get(clip.clipId);
      return value === undefined || value === null;
    });
    if (broken.length === 0 && unknown.length === 0) {
      checks.push(check("overlays_present", true, { detail: `${graphics.length} graphics overlay(s) drawn` }));
    } else {
      const detail = [
        broken.length > 0 ? `overlay(s) missing from the frame: ${broken.map((clip) => clip.clipId).join(", ")}` : "",
        unknown.length > 0 ? `no measurement for: ${unknown.map((clip) => clip.clipId).join(", ")}` : "",
      ]
        .filter((part) => part.length > 0)
        .join("; ");
      checks.push(check("overlays_present", false, { value: broken.length, limit: 0, detail }));
      for (const clip of broken) {
        const shotId = shotIdIfAny(clip.clipId);
        attribute("overlays_present", { layer: "graphics", ...(shotId === undefined ? {} : { shotId }) });
        if (shotId !== undefined) failingShotIds.push(shotId);
      }
    }
  }

  // 6. No black frame at the cuts and the sample positions (Bible 12.3).
  const required = requiredFrameTimes(edl);
  if (input.blackFrames === undefined) {
    checks.push(notEvaluated("black_frames_absent", `no black-frame measurement reached the review for ${required.length} frame(s)`));
  } else {
    const measured = new Map(input.blackFrames.map((item) => [item.atMs, item.black] as const));
    const unmeasured = required.filter((time) => measured.get(time) === undefined || measured.get(time) === null);
    const black = required.filter((time) => measured.get(time) === true);
    const detail = [
      black.length > 0 ? `black frame(s) at ${black.join(", ")} ms` : "",
      unmeasured.length > 0 ? `${unmeasured.length} frame(s) not measured` : "",
    ]
      .filter((part) => part.length > 0)
      .join("; ");
    checks.push(check("black_frames_absent", black.length === 0 && unmeasured.length === 0, { value: black.length, limit: 0, detail: detail || undefined }));
    for (const time of black) {
      const shotId = shotAt(edl, time);
      attribute("black_frames_absent", shotId === null ? {} : { shotId });
      if (shotId !== null) failingShotIds.push(shotId);
    }
  }

  // 7. The captions read from the frames match the script words (Bible 12.3, OCR).
  if (input.ocr === undefined) {
    checks.push(notEvaluated("captions_ocr_match_script", "the captions were not read from the frames"));
  } else if (input.ocr.captionWordsChecked === 0) {
    checks.push(check("captions_ocr_match_script", false, { detail: "no caption word was read from the frames" }));
  } else {
    const mismatched = input.ocr.captionWordsMismatched;
    checks.push(
      check("captions_ocr_match_script", mismatched === 0, {
        value: mismatched,
        limit: 0,
        detail: `${input.ocr.captionWordsChecked} caption words read, ${mismatched} do not match the script`,
      }),
    );
  }

  // 8. No forbidden term on screen (Bible 12.3 claims, 13 forbidden terms). Both the EDL's text and the text read from the frames.
  const terms = (input.forbiddenTerms ?? []).map((term) => term.trim()).filter((term) => term.length > 0);
  if (input.forbiddenTerms === undefined) {
    checks.push(notEvaluated("forbidden_terms_absent", "the product kit's forbidden terms are not known"));
  } else if (input.ocr === undefined) {
    checks.push(notEvaluated("forbidden_terms_absent", "the text on screen was not read from the frames"));
  } else {
    const text = [...onScreenTextOf(edl), ...input.ocr.onScreenText].join(" \n ");
    const hits = terms.filter((term) => containsTerm(text, term));
    checks.push(
      check("forbidden_terms_absent", hits.length === 0, {
        value: hits.length,
        limit: 0,
        detail: hits.length === 0 ? undefined : `${hits.length} forbidden term(s) are on screen`,
      }),
    );
  }

  // 9. The final Critic: the nine rubric scores and the confidence (Bible 12.3, 12.4). One gold set covers every rubric item.
  const floor = thresholds.take.slopRubricItemMin.value;
  const confidenceFloor = thresholds.escalation.criticConfidence.value;
  // A critic that gave no answer has no rubric rows: its missing rows would share the gold set's rule names, and a proven set would then
  // block on missing evidence. One row names the gap instead, and it has no gold set (Bible 12, 12.4).
  if (input.critic.status === "not_answered") {
    checks.push(notEvaluated("critic_final_answered", input.critic.reason));
  } else {
    for (const item of FINAL_RUBRIC_ITEMS) {
      const score = input.critic.rubric[item];
      checks.push(check(`rubric_${item}`, score >= floor, { value: score, limit: floor }));
    }
    const sure = input.critic.confidence >= confidenceFloor;
    checks.push(
      check("critic_confidence", sure, {
        value: input.critic.confidence,
        limit: confidenceFloor,
        detail: sure
          ? `the final Critic (${input.critic.answeredBy}) is sure of its rubric`
          : `the final Critic (${input.critic.answeredBy}) is unsure, so the video goes to a human`,
      }),
    );
  }

  const gate = gateResult(POST_RENDER_GATE, rendered.videoId, checks, asShotIds(failingShotIds));
  const failures: ReviewFailure[] = [];
  for (const item of checks) {
    if (item.pass) continue;
    const places = attributed.get(item.rule) ?? [];
    if (places.length === 0) {
      failures.push({ rule: item.rule });
      continue;
    }
    for (const place of places) {
      failures.push({ rule: item.rule, ...(place.shotId === undefined ? {} : { shotId: place.shotId }), ...(place.layer === undefined ? {} : { layer: place.layer }) });
    }
  }
  return { gate, failures };
}

/**
 * The gold metrics of every rubric check, by check key, from the one critic gold set (Bible 12.4). decideGate reads metrics by
 * "post_render:<rule>", so each rubric rule maps to the shared set. Other rules have no gold set here and cannot block.
 */
export function criticGoldMetricsByCheck(metrics: GoldMetrics | undefined): Record<string, GoldMetrics | undefined> {
  const byCheck: Record<string, GoldMetrics | undefined> = {};
  for (const item of FINAL_RUBRIC_ITEMS) {
    byCheck[checkKey(POST_RENDER_GATE, `rubric_${item}`)] = metrics;
  }
  return byCheck;
}
