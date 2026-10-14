// Frame grid and the grammar's shot-length target (Bible 8.2 step 1 and step 4). Pure.

import { EDIT_TUNING } from "./tuning.ts";

/** The EDL frame rate. contracts/edl.ts fixes fps at 30. */
export const FPS = 30;

/** Round a time to the nearest whole frame, returned as integer milliseconds. */
export function roundToFrame(ms: number): number {
  return Math.round((Math.round((ms * FPS) / 1000) * 1000) / FPS);
}

/**
 * The grammar's target shot length at a time. curve holds ten values, the median shot length in each tenth of the video
 * (contracts/analysis.ts). A value that is not a positive number cannot be a target, so the floor keeps the fit step finite.
 */
export function shotTargetMs(curve: readonly number[], midMs: number, totalMs: number): number {
  const share = totalMs > 0 ? Math.min(Math.max(midMs / totalMs, 0), 0.999999) : 0;
  const tenth = Math.floor(share * curve.length);
  const value = curve[tenth] ?? curve[curve.length - 1] ?? EDIT_TUNING.fit.shortShare;
  return Math.max(value, 1);
}
