/**
 * The decision behind linked playback. Pure. A video that has just changed state is compared with the other one, and the
 * other is brought into line: same paused state, and the same time when they have drifted apart.
 */

export const SYNC_TOLERANCE_SECONDS = 0.25;

/** Within this many milliseconds of a programmatic change, events from that element are ignored, so two videos cannot ping-pong. */
export const SYNC_ECHO_WINDOW_MS = 400;

export type PlaybackState = { paused: boolean; time: number };

export type SyncStep = { play: boolean; pause: boolean; seekTo: number | null };

export function syncPlan(source: PlaybackState, target: PlaybackState, tolerance: number = SYNC_TOLERANCE_SECONDS): SyncStep {
  const play = !source.paused && target.paused;
  const pause = source.paused && !target.paused;
  const bothTimed = Number.isFinite(source.time) && Number.isFinite(target.time);
  const drifted = bothTimed && Math.abs(source.time - target.time) > tolerance;
  return { play, pause, seekTo: drifted ? source.time : null };
}

/** True when an event from an element should be ignored because this screen just changed that element. */
export function isEcho(lastProgrammaticAt: number | undefined, now: number, windowMs: number = SYNC_ECHO_WINDOW_MS): boolean {
  return lastProgrammaticAt !== undefined && now - lastProgrammaticAt < windowMs;
}
