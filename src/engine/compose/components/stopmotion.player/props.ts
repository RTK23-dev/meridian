// Props for stopmotion.player (Bible 7.1 `stop_motion`, 9.2): an ordered list of frame images played at a frame rate.
// The frames are the takes of a shot's image.edit calls (a chain, engine-contracts@5). The component is sourceBound: the
// compiler refuses any frame that is not one of the shot's own sources, so no free URL reaches the page.
//
// Timing is fixed by fps alone. Frame i shows from frameStartMs(i) to frameStartMs(i + 1); the last frame shows to the clip
// end. A list is accepted only when its length is the count the clip needs at its fps (framesNeeded). A shorter list leaves
// the end blank, and a longer one has frames that start at or after the clip end and would never show. Both are refused
// with the count the clip needs. Nothing is clamped: a list is never truncated to the ceiling or padded to the floor.

import { z } from "zod";
import { imageUriSchema, withDuration } from "../shared.ts";

/** Fewest frames a stop-motion clip takes (Bible 7.1: 24 to 36 image.edit frames). A shorter list is refused, never padded. */
export const MIN_STOP_MOTION_FRAMES = 24;
/** Most frames one stop-motion clip takes (Bible 7.1). A longer list is refused with the count, never truncated. */
export const MAX_STOP_MOTION_FRAMES = 36;
/** Frame rates the Bible allows for stop motion (7.1: 8 to 12 fps). Whole numbers only. */
export const MIN_STOP_MOTION_FPS = 8;
export const MAX_STOP_MOTION_FPS = 12;

/**
 * Start of frame `index` in ms from the clip start. Rounded to whole milliseconds (contracts use integer ms), so frame
 * i ends exactly where frame i + 1 starts. The template computes the same expression (checked by its test).
 */
export function frameStartMs(index: number, fps: number): number {
  return Math.round((index * 1000) / fps);
}

export type FrameWindow = { index: number; startMs: number; endMs: number };

/**
 * The frames that show inside a clip of durationMs, in order. Frame i shows from its start to the next frame's start, or to
 * the clip end for the last one. For a list the props accept, every frame starts before the clip ends (propsSchema refuses the
 * rest), so the break below only guards a caller that skips the props.
 */
export function frameWindows(frameCount: number, fps: number, durationMs: number): FrameWindow[] {
  const windows: FrameWindow[] = [];
  for (let index = 0; index < frameCount; index++) {
    const startMs = frameStartMs(index, fps);
    if (startMs >= durationMs) {
      break;
    }
    windows.push({ index, startMs, endMs: Math.min(frameStartMs(index + 1, fps), durationMs) });
  }
  return windows;
}

/**
 * The count a clip needs at fps: the first n whose start reaches the clip end. Only a finite positive fps and clip length are
 * meaningful; anything else throws, so a bad value can never spin this loop.
 */
export function framesNeeded(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`framesNeeded needs a positive fps and clip length, got ${fps} fps and ${durationMs} ms`);
  }
  let count = 0;
  while (frameStartMs(count, fps) < durationMs) {
    count += 1;
  }
  return count;
}

const frameUrisSchema = z.array(imageUriSchema).superRefine((frames, ctx) => {
  if (frames.length < MIN_STOP_MOTION_FRAMES) {
    ctx.addIssue({
      code: "custom",
      message: `a stop-motion clip needs at least ${MIN_STOP_MOTION_FRAMES} frames (Bible 7.1); this one has ${frames.length}`,
    });
  }
  if (frames.length > MAX_STOP_MOTION_FRAMES) {
    ctx.addIssue({
      code: "custom",
      message: `a stop-motion clip takes at most ${MAX_STOP_MOTION_FRAMES} frames (Bible 7.1); this one has ${frames.length}, so it is refused, not clamped`,
    });
  }
});

export const propsSchema = withDuration({
  fps: z
    .int({ message: "fps must be a whole number of frames per second" })
    .min(MIN_STOP_MOTION_FPS, { message: `fps must be at least ${MIN_STOP_MOTION_FPS} (Bible 7.1)` })
    .max(MAX_STOP_MOTION_FPS, { message: `fps must be at most ${MAX_STOP_MOTION_FPS} (Bible 7.1)` }),
  frameUris: frameUrisSchema,
}).superRefine((props, ctx) => {
  const frameCount = props.frameUris.length;
  const countInRange = frameCount >= MIN_STOP_MOTION_FRAMES && frameCount <= MAX_STOP_MOTION_FRAMES;
  const rateInRange = Number.isInteger(props.fps) && props.fps >= MIN_STOP_MOTION_FPS && props.fps <= MAX_STOP_MOTION_FPS;
  const durationOk = Number.isInteger(props.durationMs) && props.durationMs > 0;
  if (!countInRange || !rateInRange || !durationOk) {
    return; // the count, the rate or the length is refused on its own, with its own reason
  }
  const needed = framesNeeded(props.durationMs, props.fps);
  if (frameCount === needed) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: timingProblem(frameCount, needed, props.fps, props.durationMs),
    path: ["frameUris"],
  });
});

/** Why a list whose count is in range does not fit its clip: it is short (blank end), long (frames never show) or the wrong size. */
function timingProblem(frameCount: number, needed: number, fps: number, durationMs: number): string {
  const coveredMs = frameStartMs(frameCount, fps);
  if (needed > MAX_STOP_MOTION_FRAMES) {
    return `at ${fps} fps the ${durationMs} ms clip would need ${needed} frames, more than the ${MAX_STOP_MOTION_FRAMES} allowed: lower the fps or shorten the shot`;
  }
  if (needed < MIN_STOP_MOTION_FRAMES) {
    return `at ${fps} fps the ${durationMs} ms clip needs ${needed} frames, fewer than the ${MIN_STOP_MOTION_FRAMES} allowed: raise the fps or lengthen the shot`;
  }
  if (frameCount < needed) {
    return `the ${frameCount} frames run to ${coveredMs} ms, short of the ${durationMs} ms clip, so the end would be blank; at ${fps} fps it needs ${needed} frames`;
  }
  return `the ${frameCount} frames run to ${coveredMs} ms, past the ${durationMs} ms clip: ${frameCount - needed} of them start at or after the clip end and would never show, so the list is refused, not clamped; at ${fps} fps it needs ${needed} frames`;
}

export type StopMotionProps = z.infer<typeof propsSchema>;
