/**
 * Universal Evidence Platform Types
 *
 * Defines the canonical evidence abstraction:
 * SOURCE -> RAW ARTIFACT -> OBSERVATION -> EVIDENCE BUNDLE -> JEV JUDGMENT
 */

export type EvidenceFieldState =
  | "OBSERVED"  // Direct physical observation (e.g. views = 180,000, face on screen)
  | "COMPUTED"  // Deterministic calculation (e.g. views / followers = 14.2x)
  | "INFERRED"  // Probabilistic estimation / semantic attribution
  | "LEARNED"   // Cross-observation empirical correlation
  | "VALIDATED"; // Confirmed in first-party experiments

export type EvidenceState = EvidenceFieldState;

export type EvidenceValue<T> = {
  value: T;
  state: EvidenceFieldState;
  source?: string | import("../jev/types.ts").EvidenceRef[];
  observedAt?: string;
  methodId?: string;
  uncertainty?: {
    kind?: "interval" | "distribution" | "qualitative";
    lower?: number;
    upper?: number;
    confidence?: number;
    value?: unknown;
  };
  evidenceRefs?: import("../jev/types.ts").EvidenceRef[];
};

export function asEvidenceValue<T>(
  val: T | EvidenceValue<T> | undefined,
  defaultState: EvidenceFieldState = "OBSERVED",
  uncertainty?: { lower?: number; upper?: number; confidence?: number },
): EvidenceValue<T> | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "object" && val !== null && "state" in val && "value" in val) {
    return val as EvidenceValue<T>;
  }
  return {
    value: val as T,
    state: defaultState,
    uncertainty,
  };
}

export function getNumericEvidence(
  field: number | EvidenceValue<number> | undefined,
): number | undefined {
  if (field === undefined || field === null) return undefined;
  if (typeof field === "number") return field;
  return field.value;
}

export type Provenance = {
  adapterId: string;
  sourceUrl?: string;
  externalId?: string;
  capturedAt: string;
  contentHash?: string;
  mediaHash?: string;
  licenseBasis?: string;
  retentionPolicy?: string;
};

export type TranscriptEvidence = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  speakerId?: string;
};

export type SceneEvidence = {
  index: number;
  startMs: number;
  endMs: number;
  shotType?: string;
  cameraMovement?: string;
  subjectCount?: number;
  facePresence?: boolean;
  facePosition?: { x: number; y: number; width: number; height: number };
  productPresence?: boolean;
  productAreaPercent?: number;
  visualClutterScore?: number;
  brightness?: number;
  contrast?: number;
  keyframeRef?: string;
};

export type OcrEvidence = {
  text: string;
  startMs: number;
  endMs: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  role?: "hook_line" | "benefit" | "price" | "cta" | "other";
  confidence: number;
};

export type AudioEvidence = {
  speechWpm?: number;
  audioEnergyScore?: number;
  silenceRatio?: number;
  musicPresence?: boolean;
  tempoBpm?: number;
  speechPresence?: boolean;
};

export type CommentEvidence = {
  id: string;
  text: string;
  intentCategory?:
    | "question"
    | "desire"
    | "skepticism"
    | "price"
    | "where_to_buy"
    | "tag"
    | "identification"
    | "objection"
    | "confusion"
    | "imitation_intent"
    | "praise";
  isSpam?: boolean;
  likesCount?: number;
};

export type DerivedMetric = {
  name: string;
  value: number;
  state: EvidenceFieldState;
  formula: string;
};

export type ComparisonContext = {
  creatorMedianViews?: number;
  categoryMedianViews?: number;
  adjacentMedianViews?: number;
  outlierRatio?: number;
  controlSampleIds?: string[];
};

export type EvidenceBundle = {
  id: string;
  organizationId: string;
  brandId: string;

  source: {
    platform: string;
    canonicalUrl?: string;
    externalId?: string;
    sourceAdapter: string;
    capturedAt: string;
  };

  content: {
    type: "video" | "image" | "website" | "profile" | "document";
    title?: string;
    caption?: string;
    description?: string;
  };

  profile?: {
    creatorId?: string;
    creatorName?: string;
    creatorHandle?: string;
    followers?: number;
    following?: number;
    category?: string;
    niche?: string;
    bio?: string;
  };

  performance?: {
    views?: EvidenceValue<number> | number;
    likes?: EvidenceValue<number> | number;
    comments?: EvidenceValue<number> | number;
    shares?: EvidenceValue<number> | number;
    saves?: EvidenceValue<number> | number;
    reach?: EvidenceValue<number> | number;
    capturedAt?: string;
  };

  transcript?: TranscriptEvidence[];
  scenes?: SceneEvidence[];
  ocr?: OcrEvidence[];
  audio?: AudioEvidence;
  comments?: CommentEvidence[];
  derivedMetrics?: DerivedMetric[];
  comparisonContext?: ComparisonContext;

  provenance: Provenance;
  createdAt: string;
};
