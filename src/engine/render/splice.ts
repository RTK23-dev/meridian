// The splice plan of a remake (Bible 5.5, item 7): which part of a delivered video a change re-renders, and which parts of the previous master
// are kept and joined around it. Pure: no render, no media call and no store. The plan is a claim about the timeline only. It is used only where
// the window render and the join exist and are verified; until then a remake renders the whole video (the full render), and the plan says so.

/** A span of the timeline, in milliseconds, from `fromMs` up to `toMs` (exclusive). */
export type Span = { fromMs: number; toMs: number };

export type SpliceSegment = { kind: "keep"; span: Span } | { kind: "render"; span: Span };

export type SplicePlan =
  | { status: "splice"; window: Span; segments: SpliceSegment[] }
  | { status: "full"; reason: string };

/** A changed shot's span on the timeline (the plan's start and end). */
export type ChangedSpan = { startMs: number; endMs: number };

/**
 * The window a change re-renders: the changed shots\' spans, widened to the nearest beat boundary on each side so that no caption or spoken
 * word straddles the window\'s edge, and clamped to the video. A splice is planned only when the changed shots form one window that leaves some
 * of the video to keep. Otherwise the plan is a full render, and the reason says why.
 */
export function splicePlanOf(input: { totalMs: number; changed: readonly ChangedSpan[]; beatBoundariesMs: readonly number[] }): SplicePlan {
  if (input.changed.length === 0) return { status: "full", reason: "no shot changed, so there is no window to render" };
  const from = Math.min(...input.changed.map((span) => span.startMs));
  const to = Math.max(...input.changed.map((span) => span.endMs));
  const boundaries = [...new Set([0, ...input.beatBoundariesMs, input.totalMs])].filter((ms) => ms >= 0 && ms <= input.totalMs).sort((a, b) => a - b);
  const before = boundaries.filter((ms) => ms <= from).at(-1) ?? 0;
  const after = boundaries.find((ms) => ms >= to) ?? input.totalMs;
  const window: Span = { fromMs: before, toMs: after };
  if (window.fromMs === 0 && window.toMs === input.totalMs) {
    return { status: "full", reason: "the changed shots cover the whole video, so nothing is kept" };
  }
  const segments: SpliceSegment[] = [];
  if (window.fromMs > 0) segments.push({ kind: "keep", span: { fromMs: 0, toMs: window.fromMs } });
  segments.push({ kind: "render", span: window });
  if (window.toMs < input.totalMs) segments.push({ kind: "keep", span: { fromMs: window.toMs, toMs: input.totalMs } });
  return { status: "splice", window, segments };
}
