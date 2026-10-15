// The frame_reader readings of the rendered video, for the post-render review (Bible 6.12, 12.3: overlays and on-screen text). The
// role reads the frames the review sends; this file turns its answers into the measurements the review's gate reads: whether each
// graphic is drawn in its frame, and how many caption and other text words the frame shows. Counts and presence only: no text of
// the screen is read or stored (Bible 1, principle 4). A frame the reader did not answer, or was not sure of, gives null, so a
// check that needs it fails closed.

import type { RoleDeps } from "../claude/client.ts";
import type { FrameBox } from "../claude/roles/frame_reader.ts";
import type { Frame } from "../media/index.ts";
import { analyzeConfig } from "./config.ts";
import {
  readFrames,
  type FrameReadingsOutcome,
  type FrameScope,
  type TimedReading,
} from "./frameReader.ts";

/** A graphics clip of the EDL, sampled at atMs; box is its place in the frame when the EDL sets one. */
export type GraphicsClip = { clipId: string; atMs: number; box?: FrameBox };

/** Reads the rendered frames the review sends (at most the role's frame count; the caller splits longer lists). */
export function readRenderedFrames(
  roles: RoleDeps,
  scope: FrameScope,
  frames: readonly Frame[],
): Promise<FrameReadingsOutcome> {
  return readFrames(roles, scope, frames);
}

/** The reading at exactly this time, when the review sent that frame and the reader answered it. */
function readingAt(
  readings: readonly TimedReading[],
  atMs: number,
  minConfidence: number,
): TimedReading["reading"] | null {
  const found = readings.find((item) => item.atMs === atMs);
  if (found === undefined || found.reading.confidence < minConfidence) return null;
  return found.reading;
}

/** Intersection over union of two boxes, in frame fractions (0 when they do not overlap). */
export function boxIou(a: FrameBox, b: FrameBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * Whether each graphics clip is drawn in its frame (Bible 12.3, overlays_present). An overlay counts for a clip with a box when it
 * overlaps that box by at least overlayMinIou, and for a clip with no box when the frame shows any overlay. Null when the frame
 * was not read or the reader was not sure of it.
 */
export function overlayMeasures(
  clips: readonly GraphicsClip[],
  readings: readonly TimedReading[],
  config: typeof analyzeConfig.frameReader = analyzeConfig.frameReader,
): Array<{ clipId: string; present: boolean | null }> {
  return clips.map((clip) => {
    const reading = readingAt(readings, clip.atMs, config.minConfidence);
    if (reading === null) return { clipId: clip.clipId, present: null };
    if (clip.box === undefined)
      return { clipId: clip.clipId, present: reading.overlays.length > 0 };
    const box = clip.box;
    return {
      clipId: clip.clipId,
      present: reading.overlays.some((overlay) => boxIou(overlay.box, box) >= config.overlayMinIou),
    };
  });
}

/**
 * The caption words the frame at atMs shows: the words of its caption boxes, a count only (Bible 12.3, captions). Null when the
 * frame was not read or the reader was not sure of it.
 */
export function captionWordsAt(
  readings: readonly TimedReading[],
  atMs: number,
  config: typeof analyzeConfig.frameReader = analyzeConfig.frameReader,
): number | null {
  const reading = readingAt(readings, atMs, config.minConfidence);
  if (reading === null) return null;
  return reading.captions.reduce((sum, caption) => sum + caption.words, 0);
}

/**
 * The text words the frame at atMs shows outside its captions (a title card, a price): a count only. Null when the frame was not
 * read or the reader was not sure of it. The words themselves are never returned, so a forbidden term cannot be checked here
 * (review/gates/postRender.ts forbidden_terms_absent stays not evaluated).
 */
export function textWordsAt(
  readings: readonly TimedReading[],
  atMs: number,
  config: typeof analyzeConfig.frameReader = analyzeConfig.frameReader,
): number | null {
  const reading = readingAt(readings, atMs, config.minConfidence);
  return reading === null ? null : reading.textWords;
}
