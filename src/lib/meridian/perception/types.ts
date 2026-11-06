import type { Sql } from "../learning/store.ts";

/**
 * Perception contracts. A perception provider extracts grounded observations from images and video frames. It does not
 * judge them: a DecisionEngine judges the textual evidence under Meridian's policy. A perception provider is never a decision
 * engine, and a decision engine is never used for perception.
 *
 * A perception result is one of: observed (observations for the media that was analysed), failed (the provider was called and
 * did not produce usable observations, with a kind), or never called. Nothing is filled in to hide a gap.
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
 * What a provider reported about one piece of media. Every field here is a model's inference from the pixels, so the
 * basis is `inferred`. A field the model did not report, or reported as unknown, is `null` or absent, and both mean unknown.
 * Nothing downstream may treat an absent field as a negative.
 */
export type MediaObservation = {
  mediaId: string;
  sha256: string;
  timestampMs: number | null;
  basis: "inferred";
  shotType?: "close_up" | "medium_shot" | "wide_shot" | "macro" | "screen_recording" | "unknown";
  productPresence?: boolean | null;
  productProminence?: "prominent" | "visible_small" | "not_visible" | null;
  productObstructed?: boolean | null;
  facePresence?: boolean | null;
  presenterPresence?: boolean | null;
  setting?: "indoor" | "outdoor" | "studio" | "vehicle" | "screen" | "unknown";
  motionIntensity?: number;
  contrastRatio?: number;
  typographyDensity?: number;
  dominantColors?: string[];
  /** On-screen text the model read. Empty or absent means none was reported. */
  ocrText?: string;
  sharpness?: "sharp" | "soft" | "blurred" | null;
  lighting?: "good" | "poor" | "mixed" | null;
  composition?: "balanced" | "cluttered" | "unclear" | null;
  legibility?: "legible" | "partly_legible" | "illegible" | "no_text" | null;
  artifactsVisible?: boolean | null;
};

export type PerceptionFailureKind =
  | "not_configured"
  | "credential_unusable"
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

/** Where a call is recorded and paid from, for a provider that holds its own spend (the OpenRouter path). */
export type PerceptionCallContext = { sql: Sql; organizationId: string; brandId: string; runId: string };

/** A provider's own key check. `apiKey` is empty for a provider whose key is resolved inside its call path. */
export type PerceptionCredentialCheck =
  | { status: "ready"; source: string; apiKey: string }
  | { status: "unusable" | "not_configured"; reason: string };

export interface MultimodalPerceptionProvider {
  readonly id: string;
  readonly model: string;
  /** Versions the instructions and the output shape. A change here is a change in what was observed, so it is recorded. */
  readonly promptVersion: string;
  /** Whether the provider module can run. Credentials are resolved per request by perception/credential.ts, not here. */
  health(): Promise<PerceptionHealth>;
  /**
   * The provider's own key check, when its key is not the workspace's Gemini perception key. Without it, the runner resolves the Gemini
   * key, as before.
   */
  resolveCredential?(sql: Sql, organizationId: string): Promise<PerceptionCredentialCheck>;
  /** True when the provider's call path records its own spend, so the runner records none. */
  readonly meteredElsewhere?: boolean;
  /** The credential is passed in by the caller that resolved it, so the request uses the same credential the panel reports. */
  perceive(
    input: { kind: PerceptionMediaKind; media: PerceptionMedia[] },
    options: { apiKey: string; context?: PerceptionCallContext },
  ): Promise<PerceptionResult>;
}
