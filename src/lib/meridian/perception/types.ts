/**
 * Perception contracts. A perception provider extracts grounded observations from images and video frames. It does not
 * judge them: a DecisionEngine judges the evidence under Meridian's policy. Keeping the two apart means a perception
 * provider can be replaced without touching any decision, and no decision engine is ever a perception provider.
 *
 * Every result is one of three things: observed (observations for the media that was analysed), failed (the provider was
 * called and did not produce usable observations), or unavailable (no call was made). Nothing is filled in to hide a gap.
 */

export type PerceptionMediaKind = "image" | "video_frames";

export type PerceptionMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** One piece of media a provider is asked to analyse. A still image has no timestamp; a video frame has its real one. */
export type PerceptionMedia = {
  id: string;
  bytes: Uint8Array;
  mimeType: PerceptionMimeType;
  sha256: string;
  timestampMs: number | null;
};

/**
 * What the perception model reported about one piece of media. These are the model's descriptions, so `basis` is always
 * `model_description`. They are not measurements, and nothing downstream may treat them as one.
 */
export type MediaObservation = {
  mediaId: string;
  sha256: string;
  timestampMs: number | null;
  basis: "model_description";
  shotType?: "close_up" | "medium_shot" | "wide_shot" | "macro" | "screen_recording" | "unknown";
  productPresence?: boolean;
  facePresence?: boolean;
  presenterPresence?: boolean;
  setting?: "indoor" | "outdoor" | "studio" | "vehicle" | "screen" | "unknown";
  motionIntensity?: number;
  contrastRatio?: number;
  typographyDensity?: number;
  dominantColors?: string[];
  /** On-screen text the model read. Empty or absent means none was reported. */
  ocrText?: string;
};

export type PerceptionFailureKind =
  | "not_configured"
  | "unsupported_media"
  | "no_media"
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "invalid_response"
  | "network";

export type PerceptionUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

export type PerceptionResult =
  | {
      status: "observed";
      providerId: string;
      model: string;
      promptVersion: string;
      observations: MediaObservation[];
      latencyMs: number;
      usage?: PerceptionUsage;
    }
  | {
      status: "failed";
      providerId: string;
      model: string;
      promptVersion: string;
      failureKind: PerceptionFailureKind;
      message: string;
      latencyMs: number;
    };

export type PerceptionHealth = {
  id: string;
  state: "HEALTHY" | "NOT_CONFIGURED" | "UNAVAILABLE";
  detail: string;
};

export interface MultimodalPerceptionProvider {
  readonly id: string;
  readonly model: string;
  /** Versions the instructions and output shape. A change here is a change in what was observed, so it is recorded. */
  readonly promptVersion: string;
  health(): Promise<PerceptionHealth>;
  perceive(input: { kind: PerceptionMediaKind; media: PerceptionMedia[] }): Promise<PerceptionResult>;
}
