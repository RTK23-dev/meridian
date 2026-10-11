/**
 * Four frames from a video's scene timeline: the highest-relevance scene in each quarter of the timeline.
 *
 * The timeline is split into four equal spans of its duration. A scene belongs to the span that holds its midpoint. In each
 * span the scene with the highest relevance is chosen, and a tie goes to the earlier start, then to the id. The frame's
 * timestamp is that scene's real start, as the scene timeline reports it.
 *
 * Nothing is invented. A scene with no relevance score is never chosen, because nothing shows it matters. A span with no
 * scored scene stays empty, and the result names it. When the timeline is missing, or holds fewer than four valid scenes, the
 * result returns the scenes that exist, in time order, and says how many there are. It never fills a slot with a frame or a
 * timestamp that the timeline does not contain.
 *
 * The selector is pure. Decoding a frame at a chosen timestamp is a separate step (video/sample-frames.ts, `timestampsMs`).
 */

export const SCENE_FRAME_SELECTION_VERSION = "scene-span-frames.v1";
export const SCENE_FRAME_SPANS = 4;

export type TimelineScene = {
  id: string;
  /** Where the scene starts in the source media, in ms, as the timeline reports it. */
  startMs: number;
  /** Where the scene ends in the source media, in ms. Must be after startMs. */
  endMs: number;
  /** Relevance from the caller's scoring. Null when the scene has not been scored, and such a scene is never chosen. */
  relevance: number | null;
  keyframeRef?: string;
};

export type SceneFrame = {
  /** The quarter of the timeline the frame was chosen for, 1 to 4. */
  span: number;
  sceneId: string;
  /** The scene's real start time. */
  timestampMs: number;
  relevance: number | null;
  keyframeRef?: string;
  reason: string;
};

export type SceneFrameOmission = {
  sceneId: string;
  reason: "invalid_timestamps" | "outside_timeline" | "unscored" | "not_selected";
};

export type SceneFrameStatus =
  /** Four frames, one per span. */
  | "selected"
  /** At least four valid scenes, but one or more spans held no scored scene. */
  | "partial"
  /** Fewer than four valid scenes. The scenes that exist are returned in time order. */
  | "fewer_than_four_scenes"
  /** No timeline, or an empty one. Nothing is returned. */
  | "no_timeline";

export type SceneFrameSelection = {
  version: typeof SCENE_FRAME_SELECTION_VERSION;
  status: SceneFrameStatus;
  /** How many valid scenes the timeline holds. Scenes that could not be used are counted in `omitted`, not here. */
  sceneCount: number;
  /** The timeline length used for the spans, in ms. Null when there was no timeline. */
  durationMs: number | null;
  /** Spans, 1 to 4, that held no scored scene. */
  emptySpans: number[];
  /** Frames in time order. */
  frames: SceneFrame[];
  omitted: SceneFrameOmission[];
  /** A sentence a reviewer can read: how many scenes there were and why the result has the frames it has. */
  summary: string;
};

type ValidScene = TimelineScene & { midpointMs: number };

function isValid(scene: TimelineScene): boolean {
  return (
    typeof scene.startMs === "number" &&
    typeof scene.endMs === "number" &&
    Number.isFinite(scene.startMs) &&
    Number.isFinite(scene.endMs) &&
    scene.startMs >= 0 &&
    scene.endMs > scene.startMs
  );
}

function scoredRelevance(scene: TimelineScene): number | null {
  return typeof scene.relevance === "number" && Number.isFinite(scene.relevance) ? scene.relevance : null;
}

/**
 * The timeline length the spans cover. A stated duration is used when it is a positive number that holds every scene. Without
 * one, the span of the scenes is used, and nothing is assumed beyond the last scene.
 */
function timelineLength(scenes: ValidScene[], statedDurationMs: number | null | undefined): number {
  const latestEnd = Math.max(...scenes.map((scene) => scene.endMs));
  if (typeof statedDurationMs === "number" && Number.isFinite(statedDurationMs) && statedDurationMs > 0) {
    return statedDurationMs;
  }
  return latestEnd;
}

export function selectSceneSpanFrames(
  timeline: readonly TimelineScene[] | null | undefined,
  options: { durationMs?: number | null } = {},
): SceneFrameSelection {
  const base = { version: SCENE_FRAME_SELECTION_VERSION } as const;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return {
      ...base,
      status: "no_timeline",
      sceneCount: 0,
      durationMs: null,
      emptySpans: [],
      frames: [],
      omitted: [],
      summary: "No scene timeline was supplied, so no frame was selected.",
    };
  }

  const omitted: SceneFrameOmission[] = [];
  const valid: TimelineScene[] = [];
  for (const scene of timeline) {
    if (!isValid(scene)) {
      omitted.push({ sceneId: scene.id, reason: "invalid_timestamps" });
      continue;
    }
    valid.push(scene);
  }
  if (valid.length === 0) {
    return {
      ...base,
      status: "no_timeline",
      sceneCount: 0,
      durationMs: null,
      emptySpans: [],
      frames: [],
      omitted,
      summary: `The scene timeline has ${timeline.length} scene${timeline.length === 1 ? "" : "s"}, and none has usable timestamps, so no frame was selected.`,
    };
  }

  const sorted = [...valid].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  const sceneCount = sorted.length;

  if (sceneCount < SCENE_FRAME_SPANS) {
    const frames: SceneFrame[] = sorted.map((scene) => ({
      span: spanOf(scene, timelineLength(sorted.map(withMidpoint), options.durationMs)),
      sceneId: scene.id,
      timestampMs: scene.startMs,
      relevance: scoredRelevance(scene),
      ...(scene.keyframeRef ? { keyframeRef: scene.keyframeRef } : {}),
      reason: `The timeline has ${sceneCount} scene${sceneCount === 1 ? "" : "s"}, fewer than ${SCENE_FRAME_SPANS}. This scene starts at ${scene.startMs} ms.`,
    }));
    return {
      ...base,
      status: "fewer_than_four_scenes",
      sceneCount,
      durationMs: timelineLength(sorted.map(withMidpoint), options.durationMs),
      emptySpans: [],
      frames,
      omitted,
      summary: `The timeline has ${sceneCount} scene${sceneCount === 1 ? "" : "s"}, fewer than ${SCENE_FRAME_SPANS}. Those scenes are returned, and no other frame is added.`,
    };
  }

  const scenes: ValidScene[] = sorted.map(withMidpoint);
  const durationMs = timelineLength(scenes, options.durationMs);
  const bySpan = new Map<number, ValidScene[]>();
  for (const scene of scenes) {
    // A scene lies outside a stated duration only when the duration is shorter than the scene. That is not a frame of this video.
    if (scene.midpointMs > durationMs) {
      omitted.push({ sceneId: scene.id, reason: "outside_timeline" });
      continue;
    }
    const span = spanOf(scene, durationMs);
    bySpan.set(span, [...(bySpan.get(span) ?? []), scene]);
  }

  const frames: SceneFrame[] = [];
  const emptySpans: number[] = [];
  for (let span = 1; span <= SCENE_FRAME_SPANS; span += 1) {
    const candidates = (bySpan.get(span) ?? []).filter((scene) => scoredRelevance(scene) !== null);
    if (candidates.length === 0) {
      emptySpans.push(span);
      continue;
    }
    const best = candidates.reduce((winner, scene) => {
      const a = scoredRelevance(scene) as number;
      const b = scoredRelevance(winner) as number;
      if (a !== b) return a > b ? scene : winner;
      if (scene.startMs !== winner.startMs) return scene.startMs < winner.startMs ? scene : winner;
      return scene.id.localeCompare(winner.id) < 0 ? scene : winner;
    });
    frames.push({
      span,
      sceneId: best.id,
      timestampMs: best.startMs,
      relevance: scoredRelevance(best),
      ...(best.keyframeRef ? { keyframeRef: best.keyframeRef } : {}),
      reason: `Highest relevance in span ${span} of ${SCENE_FRAME_SPANS}. This scene starts at ${best.startMs} ms.`,
    });
  }
  for (const scene of scenes) {
    if (omitted.some((entry) => entry.sceneId === scene.id)) continue;
    if (!frames.some((frame) => frame.sceneId === scene.id)) {
      omitted.push({ sceneId: scene.id, reason: scoredRelevance(scene) === null ? "unscored" : "not_selected" });
    }
  }
  frames.sort((a, b) => a.timestampMs - b.timestampMs || a.sceneId.localeCompare(b.sceneId));

  const status: SceneFrameStatus = frames.length === SCENE_FRAME_SPANS ? "selected" : "partial";
  const summary =
    status === "selected"
      ? `Four frames, one from each quarter of a ${durationMs} ms timeline of ${sceneCount} scenes.`
      : `Only ${frames.length} of ${SCENE_FRAME_SPANS} spans held a scored scene (${sceneCount} scenes in the timeline). Empty spans: ${emptySpans.join(", ")}. No frame was added for them.`;
  return { ...base, status, sceneCount, durationMs, emptySpans, frames, omitted, summary };
}

function withMidpoint(scene: TimelineScene): ValidScene {
  return { ...scene, midpointMs: (scene.startMs + scene.endMs) / 2 };
}

/** The span of a scene: the quarter of the timeline that holds its midpoint. Midpoints at the very end belong to the last span. */
function spanOf(scene: TimelineScene, durationMs: number): number {
  const midpoint = (scene.startMs + scene.endMs) / 2;
  const index = Math.floor((midpoint / durationMs) * SCENE_FRAME_SPANS);
  return Math.min(SCENE_FRAME_SPANS, Math.max(1, index + 1));
}
