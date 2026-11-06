// The take check: a rendered or generated take is measured against its direction before it is used (L4, L6, L7, L8, L9). It reads
// numbers measured from the frames (the media functions, or the agent renderer's own measure), so it never calls a model. A finding that
// blocks is a reject reason: the shot is retried or rerouted, and the reason is logged for the learning loop (L9).

import type { DirectedFilm } from "./film.ts";

export type TakeMeasures = {
  fps: number;
  /** Mean absolute change between frame i and frame i+1, 0 to 1, for the whole film. */
  motion: number[];
  /** The loop distance between the first and the last frame, 0 to 1 (the engine's loopDistance). */
  firstLastDistance?: number;
  /** The subject's centre per sampled time, as fractions of the frame. */
  subjectTrack?: Array<{ ms: number; x: number; y: number }>;
  /** Each shot's palette distance from the look's reference frame, 0 to 1. */
  paletteDistance?: Array<{ shotId: string; distance: number }>;
  /** Avoided items a frame reader saw, per shot. */
  avoidSeen?: Array<{ shotId: string; item: string }>;
};

export type TakeRule = "moment_invisible" | "loop_open" | "subject_drift" | "look_drift" | "avoid_seen";
export type TakeFinding = { rule: TakeRule; severity: "block" | "warn"; lesson: string; at: string; message: string; value: number | null };

export type TakeCheckOptions = {
  /**
   * The moment's peak change must be this many times the shot's median change (default 4)... Measured on the microwave film and its
   * described control: directed moments stand 9 to 80 times above their shot, an idle drift with a bob 1.4 to 6 times.
   */
  momentRatio?: number;
  /** ...and at least this much (default 0.008: a subject of about 30 by 30 of 90 by 160 changing). */
  momentFloor?: number;
  /** Within this window either side of the moment (default 200 ms, L4). */
  momentWindowMs?: number;
  loopMax?: number;
  driftMax?: number;
  paletteMax?: number;
};

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

export function takeFindings(film: DirectedFilm, measures: TakeMeasures, options: TakeCheckOptions = {}): TakeFinding[] {
  const out: TakeFinding[] = [];
  const ratio = options.momentRatio ?? 4;
  const floor = options.momentFloor ?? 0.008;
  const window = options.momentWindowMs ?? 200;
  const frameOf = (ms: number) => Math.round((ms / 1000) * measures.fps);

  for (const shot of film.shots) {
    const from = frameOf(shot.startMs);
    const to = Math.min(measures.motion.length, frameOf(shot.endMs) - 1);
    const hit = frameOf(shot.startMs + shot.oneMoment.hitAtMs);
    const w = Math.max(1, frameOf(window));
    const inWindow = measures.motion.slice(Math.max(from, hit - w), Math.min(to, hit + w) + 1);
    const rest = [...measures.motion.slice(from, Math.max(from, hit - w)), ...measures.motion.slice(Math.min(to, hit + w) + 1, to)];
    const peak = inWindow.length > 0 ? Math.max(...inWindow) : 0;
    const base = median(rest);
    if (peak < floor || peak < ratio * base) {
      out.push({
        rule: "moment_invisible",
        severity: "block",
        lesson: "L4",
        at: shot.shotId,
        message: `no visible change within ${window} ms of the moment: peak ${peak.toFixed(4)} against the shot's median ${base.toFixed(4)}`,
        value: peak,
      });
    }
  }

  if (film.loop === "seamless" && measures.firstLastDistance !== undefined && measures.firstLastDistance > (options.loopMax ?? 0.04)) {
    out.push({ rule: "loop_open", severity: "block", lesson: "L8", at: "film", message: `first and last frames differ by ${measures.firstLastDistance.toFixed(3)}`, value: measures.firstLastDistance });
  }

  if (measures.subjectTrack !== undefined) {
    for (const shot of film.shots.filter((candidate) => candidate.composition.camera === "locked")) {
      const points = measures.subjectTrack.filter((point) => point.ms >= shot.startMs && point.ms < shot.endMs);
      if (points.length < 3) continue;
      const mx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const my = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const spread = Math.sqrt(points.reduce((sum, point) => sum + (point.x - mx) ** 2 + (point.y - my) ** 2, 0) / points.length);
      if (spread > (options.driftMax ?? 0.08)) {
        out.push({ rule: "subject_drift", severity: "warn", lesson: "L7", at: shot.shotId, message: `the subject wanders ${spread.toFixed(3)} of the frame in a locked shot`, value: spread });
      }
    }
  }

  for (const entry of measures.paletteDistance ?? []) {
    if (entry.distance > (options.paletteMax ?? 0.25)) {
      out.push({ rule: "look_drift", severity: "block", lesson: "L6", at: entry.shotId, message: `the palette is ${entry.distance.toFixed(2)} from the reference frame`, value: entry.distance });
    }
  }
  for (const seen of measures.avoidSeen ?? []) {
    out.push({ rule: "avoid_seen", severity: "block", lesson: "L9", at: seen.shotId, message: `the take shows an avoided item: ${seen.item}`, value: null });
  }
  return out;
}
