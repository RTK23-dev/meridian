// Props for stopmotion.player (Bible 7.1 `stop_motion`, 9.2): an ordered list of frame images played at a frame rate.
// The frames are the takes of a shot's image.edit calls (a chain, engine-contracts@5). The component is sourceBound: the
// compiler refuses any frame that is not one of the shot's own sources, so no free URL reaches the page.
//
// Timing is fixed by fps alone. Frame i shows from frameStartMs(i) to frameStartMs(i + 1), clamped to the clip. The
// frame count must cover the clip (the frames must run to its end), and frames that start after the clip are not shown.

import { z } from "zod";
import { imageUriSchema, withDuration } from "../shared.ts";

/** Fewest frames a stop-motion clip plays: one frame is a still, not motion. */
export const MIN_STOP_MOTION_FRAMES = 2;
/** Most frames one stop-motion clip takes (Bible 7.1 plans 24 to 36). A longer list is refused with the count. */
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
 * The frames that show inside a clip of durationMs, in order. Frame i shows from its start to the next frame's start,
 * or to the clip end when the clip ends first. A frame that starts at or after the clip end is not shown.
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

/** The fewest frames whose timing reaches the clip end: the first n with frameStartMs(n) at or past durationMs. */
export function framesNeeded(durationMs: number, fps: number): number {
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
      message: `a stop-motion clip needs at least ${MIN_STOP_MOTION_FRAMES} frames; this one has ${frames.length}`,
    });
  }
  if (frames.length > MAX_STOP_MOTION_FRAMES) {
    ctx.addIssue({
      code: "custom",
      message: `a stop-motion clip takes at most ${MAX_STOP_MOTION_FRAMES} frames (Bible 7.1); this one has ${frames.length}, so it is refused`,
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
  if (frameCount < MIN_STOP_MOTION_FRAMES || frameCount > MAX_STOP_MOTION_FRAMES) {
    return;
  }
  const coveredMs = frameStartMs(frameCount, props.fps);
  if (coveredMs < props.durationMs) {
    const needed = framesNeeded(props.durationMs, props.fps);
    const reason =
      needed > MAX_STOP_MOTION_FRAMES
        ? `at ${props.fps} fps it would need ${needed} frames, more than the ${MAX_STOP_MOTION_FRAMES} allowed: lower the fps or shorten the shot`
        : `at ${props.fps} fps it needs ${needed} frames`;
    ctx.addIssue({
      code: "custom",
      message: `the ${frameCount} frames run to ${coveredMs} ms, short of the ${props.durationMs} ms clip, so the end would be blank; ${reason}`,
      path: ["frameUris"],
    });
  }
});

export type StopMotionProps = z.infer<typeof propsSchema>;
