/**
 * Perception Layer Types
 *
 * Isolated perception contracts for multimodal sensory extraction (vision, audio, text OCR).
 * Perception generates raw factual observations. It DOES NOT make JEV policy or business decisions.
 */

export type VisualSceneFeatures = {
  shotType?: "close_up" | "medium_shot" | "wide_shot" | "macro" | "screen_recording" | "unknown";
  presenterPresence?: boolean;
  facePresence?: boolean;
  productPresence?: boolean;
  setting?: "indoor" | "outdoor" | "studio" | "vehicle" | "screen" | "unknown";
  motionIntensity?: number; // 0 to 1
  contrastRatio?: number; // 0 to 1
  typographyDensity?: number; // 0 to 1
  dominantColors?: string[];
};

export type AudioSceneFeatures = {
  speechDetected: boolean;
  musicPresent?: boolean;
  soundEffectsPresent?: boolean;
  energyLevel?: number; // 0 to 1
};

export type SceneObservation = {
  sceneIndex: number;
  startMs: number;
  endMs: number;
  keyframeHash?: string;
  visual: VisualSceneFeatures;
  audio?: AudioSceneFeatures;
  ocrText?: string;
  state?: "OBSERVED" | "INFERRED";
  modelQualityEstimate?: number;
  confidence?: number;
};

export type PerceptionTranscriptSegment = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  speakerId?: string;
};

export type PerceptionBundle = {
  artifactId: string;
  durationMs: number;
  scenes: SceneObservation[];
  transcriptSegments: PerceptionTranscriptSegment[];
  capturedAt: string;
  provider: string;
  model: string;
};

export type PerceptionHealth = {
  id: string;
  state: "HEALTHY" | "NOT_CONFIGURED" | "UNAVAILABLE";
  detail: string;
};

export interface MultimodalPerceptionProvider {
  readonly id: string;
  readonly model: string;

  health(): Promise<PerceptionHealth>;
  perceiveVideo(input: {
    artifactId: string;
    videoBytes?: Uint8Array;
    durationMs?: number;
    keyframes?: Array<{ sceneIndex: number; timestampMs: number; bytes: Uint8Array }>;
  }): Promise<PerceptionBundle>;
  perceiveImages?(input: {
    images: Array<{ id: string; bytes: Uint8Array; mimeType?: string }>;
  }): Promise<PerceptionBundle>;
}
