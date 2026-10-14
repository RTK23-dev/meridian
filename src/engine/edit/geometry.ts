// Frame geometry for the edit rules (Bible 8.3 safe zones and 9.2 component layout). Rectangles are fractions of the 1080 x 1920
// frame, so a pixel box from an EDL clip is converted once and then compared the same way everywhere. Pure.

import { thresholds } from "../config/thresholds.ts";
import { EDIT_TUNING, type CaptionBand } from "./tuning.ts";

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;

/** A rectangle as fractions of the frame: x and y are the top-left corner, w and h the size. */
export type Rect = { x: number; y: number; w: number; h: number };

/** Tolerance for comparisons of fractions (a right edge of exactly 0.88 is inside the zone limit, not past it). */
const EPS = 1e-9;

/** The box a caption band occupies when captions.karaoke draws it (see EDIT_TUNING.geometry). */
export function captionBandRect(band: CaptionBand): Rect {
  const geometry = EDIT_TUNING.geometry;
  return {
    x: geometry.captionLeftShare,
    y: geometry.captionTopShare[band],
    w: geometry.captionWidthShare,
    h: geometry.captionHeightShare,
  };
}

/** A clip box given in pixels (contracts/edl.ts box) as fractions of the frame. */
export function pixelBoxToRect(box: { x: number; y: number; w: number; h: number }): Rect {
  return { x: box.x / FRAME_WIDTH, y: box.y / FRAME_HEIGHT, w: box.w / FRAME_WIDTH, h: box.h / FRAME_HEIGHT };
}

/** True when any part of the rectangle is in the top, bottom or right safe-zone margin (Bible 8.3). */
export function touchesUnsafeZone(rect: Rect): boolean {
  const zone = thresholds.edit.safeZoneShare;
  const top = rect.y < zone.top - EPS;
  const bottom = rect.y + rect.h > 1 - zone.bottom + EPS;
  const right = rect.x + rect.w > 1 - zone.right + EPS;
  return top || bottom || right;
}

/** True when the two rectangles share some area. Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** The face area used when a presenter clip carries no face box. */
export function assumedFaceRect(): Rect {
  return { ...EDIT_TUNING.geometry.assumedFaceBox };
}
