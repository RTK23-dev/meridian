export type VideoAnalysis = {
  durationMs: number;
  width: number;
  height: number;
  frameRate: number | null;
  audio: "present" | "absent" | "unknown";
  transcript: string;
  scenes: { atMs: number; summary: string }[];
};

export function videoGenerationStatus(env: { videoKey?: string } = {}): {
  status: "NOT_CONNECTED";
  provider: string;
  detail: string;
} {
  return {
    status: "NOT_CONNECTED",
    provider: env.videoKey?.trim() ? "configured-without-adapter" : "",
    detail: env.videoKey?.trim()
      ? "A video key is present, but no video generation adapter is implemented. No clip was created."
      : "No video provider is connected. No clip was created.",
  };
}

/** Missing video analysis cannot approve. This does not invent a transcript. */
export function videoQa(analysis: VideoAnalysis | null): {
  decision: "HUMAN_REVIEW" | "REJECT";
  reason: string;
} {
  if (!analysis) {
    return { decision: "HUMAN_REVIEW", reason: "No video analysis is connected. The creative is not approved from a missing watch." };
  }
  if (analysis.durationMs <= 0 || analysis.width <= 0 || analysis.height <= 0) {
    return { decision: "REJECT", reason: "The video file has no usable duration or dimensions." };
  }
  if (!analysis.transcript.trim() && analysis.scenes.length === 0) {
    return { decision: "HUMAN_REVIEW", reason: "The video has timing metadata but no transcript or scene evidence." };
  }
  return { decision: "HUMAN_REVIEW", reason: "Video evidence is stored. It does not auto-approve publishing." };
}
