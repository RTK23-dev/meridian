import { buildFixtureClip, solidFrame } from "../video/inspect.ts";
import type { StoryboardTemplate } from "./template.ts";

export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export type AspectRatioDimensions = {
  width: number;
  height: number;
  safeMarginTop: number;
  safeMarginBottom: number;
};

export const ASPECT_RATIO_SPECS: Record<AspectRatio, AspectRatioDimensions> = {
  "9:16": { width: 1080, height: 1920, safeMarginTop: 180, safeMarginBottom: 320 },
  "4:5": { width: 1080, height: 1350, safeMarginTop: 100, safeMarginBottom: 150 },
  "1:1": { width: 1080, height: 1080, safeMarginTop: 80, safeMarginBottom: 80 },
  "16:9": { width: 1920, height: 1080, safeMarginTop: 80, safeMarginBottom: 100 },
};

export type RenderTrackItem = {
  id: string;
  kind: "video" | "voiceover" | "caption" | "music" | "overlay";
  startMs: number;
  endMs: number;
  content: string;
  style?: Record<string, unknown>;
};

export type TimelineComposition = {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  durationMs: number;
  tracks: {
    video: RenderTrackItem[];
    audio: RenderTrackItem[];
    overlay: RenderTrackItem[];
  };
};

export type RenderTimelineOptions = {
  template: StoryboardTemplate;
  variant: {
    hook: string;
    cta: string;
    presenter: string;
    lengthMs: number;
  };
  aspectRatio: AspectRatio;
  brandColors?: { primary?: string; accent?: string };
};

/**
 * Builds the timeline composition for the specified aspect ratio.
 */
export function buildTimelineComposition(options: RenderTimelineOptions): TimelineComposition {
  const spec = ASPECT_RATIO_SPECS[options.aspectRatio] ?? ASPECT_RATIO_SPECS["9:16"];
  const durationMs = options.variant.lengthMs;

  const videoTracks: RenderTrackItem[] = [];
  const audioTracks: RenderTrackItem[] = [];
  const overlayTracks: RenderTrackItem[] = [];

  const beats = options.template.beats;
  const beatCount = beats.length || 1;
  const beatDuration = Math.round(durationMs / beatCount);

  beats.forEach((beat, index) => {
    const startMs = index * beatDuration;
    const endMs = index === beatCount - 1 ? durationMs : (index + 1) * beatDuration;

    videoTracks.push({
      id: `v_beat_${index}`,
      kind: "video",
      startMs,
      endMs,
      content: `${beat.shotType} with ${options.variant.presenter}`,
    });

    audioTracks.push({
      id: `a_beat_${index}`,
      kind: "voiceover",
      startMs,
      endMs,
      content: beat.role === "hook" ? options.variant.hook : beat.role === "cta" ? options.variant.cta : beat.voiceover,
    });

    if (beat.role === "hook") {
      overlayTracks.push({
        id: `o_hook`,
        kind: "overlay",
        startMs,
        endMs: Math.min(endMs, 3000),
        content: options.variant.hook,
        style: { safeTop: spec.safeMarginTop, safeBottom: spec.safeMarginBottom },
      });
    } else if (beat.role === "cta") {
      overlayTracks.push({
        id: `o_cta`,
        kind: "overlay",
        startMs,
        endMs,
        content: options.variant.cta,
        style: { safeTop: spec.safeMarginTop, safeBottom: spec.safeMarginBottom },
      });
    }
  });

  audioTracks.push({
    id: "a_music",
    kind: "music",
    startMs: 0,
    endMs: durationMs,
    content: options.template.musicMood || "upbeat",
  });

  return {
    aspectRatio: options.aspectRatio,
    width: spec.width,
    height: spec.height,
    durationMs,
    tracks: {
      video: videoTracks,
      audio: audioTracks,
      overlay: overlayTracks,
    },
  };
}

/**
 * Timeline renderer for 9:16, 4:5, 1:1, and 16:9:
 * Renders video clip bytes for the composition.
 */
export function renderTimelineToVideo(options: RenderTimelineOptions): {
  bytes: Uint8Array;
  composition: TimelineComposition;
  width: number;
  height: number;
  durationMs: number;
} {
  const composition = buildTimelineComposition(options);
  const spec = ASPECT_RATIO_SPECS[options.aspectRatio];

  // Scale down preview frame dimensions while preserving exact aspect ratio
  const previewScale = 0.1;
  const frameWidth = Math.round(spec.width * previewScale);
  const frameHeight = Math.round(spec.height * previewScale);

  const rgbMap: Record<AspectRatio, [number, number, number]> = {
    "9:16": [40, 40, 70],
    "4:5": [50, 60, 40],
    "1:1": [60, 40, 50],
    "16:9": [40, 60, 70],
  };

  const frame = solidFrame(frameWidth, frameHeight, rgbMap[options.aspectRatio]);
  const bytes = buildFixtureClip({
    durationMs: options.variant.lengthMs,
    width: spec.width,
    height: spec.height,
    frames: [frame],
  });

  return {
    bytes,
    composition,
    width: spec.width,
    height: spec.height,
    durationMs: options.variant.lengthMs,
  };
}
