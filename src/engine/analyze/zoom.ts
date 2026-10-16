// The zoom and loop readings (Bible 8.1 motion and endsOnLoop) from the picture measures (media/picture.ts). Pure: the same pairs
// give the same readings. A zoom jump is a measured pair whose scale differs from 1 by more than the Bible's 8% and whose scale
// model explains most of the frame difference (fit, analyze/config.ts). Consecutive jump pairs of one direction are one jump: its
// scale is their product, and its time is the first pair's. A pair that straddles a scene cut is not measured, and it ends a run.
// The loop is the luma distance of the first frame against the last, against its threshold. No measure, no reading: null.

import type { PicturePair } from "../media/index.ts";
import { analyzeConfig } from "./config.ts";

export type ZoomJump = { atMs: number; scale: number };

type ZoomConfig = Pick<typeof analyzeConfig, "zoomJumpMinChange" | "zoomFitMax" | "loopMaxDistance">;

/** A pair that is a jump: measured, its scale changed by more than the minimum, and its scale model fits. */
function isJumpPair(pair: PicturePair, config: ZoomConfig): boolean {
  return (
    pair.usable &&
    pair.scale !== null &&
    pair.fit !== null &&
    Math.abs(pair.scale - 1) > config.zoomJumpMinChange &&
    pair.fit <= config.zoomFitMax
  );
}

/**
 * The zoom jumps of a picture, in time order. Null when no pair was measured (every pair straddles a cut, or there are none): the
 * zoom is then not measured, and the grammar's zoom fields stay unknown. An empty list is a measured picture with no zoom jump.
 */
export function zoomJumps(
  pairs: readonly PicturePair[],
  config: ZoomConfig = analyzeConfig,
): ZoomJump[] | null {
  if (!pairs.some((pair) => pair.usable)) return null;
  const jumps: ZoomJump[] = [];
  let open: { atMs: number; scale: number; direction: number } | null = null;
  for (const pair of pairs) {
    if (pair.scale === null || !isJumpPair(pair, config)) {
      if (open !== null) jumps.push({ atMs: open.atMs, scale: open.scale });
      open = null;
      continue;
    }
    const direction = Math.sign(pair.scale - 1);
    if (open !== null && open.direction === direction) {
      open.scale *= pair.scale;
      continue;
    }
    if (open !== null) jumps.push({ atMs: open.atMs, scale: open.scale });
    open = { atMs: pair.atMs, scale: pair.scale, direction };
  }
  if (open !== null) jumps.push({ atMs: open.atMs, scale: open.scale });
  return jumps;
}

/** The loop reading: true when the last frame is within loopMaxDistance of the first; null when no distance was measured. */
export function loopOf(distance: number | null, config: ZoomConfig = analyzeConfig): boolean | null {
  return distance === null ? null : distance <= config.loopMaxDistance;
}
