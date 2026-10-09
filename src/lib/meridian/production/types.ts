/**
 * Provider-Neutral Production Types
 *
 * Contracts for rendering/generating short-form video creatives across multiple engines:
 * ManualCloud (zero spend Drive drop folder), Hypit, Veo, Higgsfield.
 */

export type CostMode = "ZERO_SPEND" | "LOWEST_COST" | "BALANCED" | "QUALITY_FIRST";

export type ProductionJobState =
  | "NOT_CONFIGURED"
  | "PENDING_PREFLIGHT"
  | "PREFLIGHT_FAILED"
  | "SUBMITTING"
  | "SUBMISSION_UNKNOWN"
  | "QUEUED"
  | "RUNNING"
  | "RENDERING"
  | "WAITING_FOR_ARTIFACT"
  | "WAITING_FOR_EXTERNAL_ARTIFACT"
  | "RENDERED"
  | "PENDING_POSTFLIGHT"
  | "POSTFLIGHT_FAILED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ProviderHealth = {
  id: string;
  state: "CONFIGURED" | "HEALTHY" | "DEGRADED" | "DEPRECATED" | "AUTH_FAILED" | "UNAVAILABLE" | "RATE_LIMITED" | "NOT_CONFIGURED";
  capabilities: string[];
  detail: string;
  checkedAt: string;
};

export type ProductionCapabilities = {
  textToVideo: boolean;
  imageToVideo: boolean;
  timelineEditing: boolean;
  voiceoverGeneration: boolean;
  zeroSpend: boolean;
  averageLatencySeconds: number;
  costPerSecondEstimateUsd: number;
};

export type CreativeSpec = {
  id: string;
  organizationId: string;
  brandId: string;
  title: string;
  format: string;
  aspectRatio: "9:16" | "16:9" | "1:1" | "4:5";
  durationTargetSeconds: number;
  hookLine: string;
  script: string;
  visualDirection?: string;
  audioDirection?: string;
  sourceMediaUrl?: string;
  scenes: Array<{
    index: number;
    description: string;
    durationSeconds: number;
    onScreenText?: string;
    voiceoverText?: string;
    assetUrl?: string;
  }>;
  audioTrack?: {
    musicStyle?: string;
    voiceId?: string;
  };
  providerId?: string;
  modelId?: string;
  assetIds?: string[];
  /** Stable Meridian key used to correlate one durable submission attempt. */
  idempotencyKey?: string;
};

export type ProductionJob = {
  jobId: string;
  meridianJobId?: string;
  organizationId: string;
  brandId: string;
  creativeSpec: CreativeSpec;
  providerId: string;
  providerJobId?: string;
  requestId?: string;
  operationName?: string;
  statusUrl?: string;
  cancelUrl?: string;
  specHash?: string;
  attemptCount?: number;
  submittedAt?: string;
  lastPolledAt?: string;
  nextPollAt?: string;
  errorCode?: string;
  status: ProductionJobState;
  costEstimateUsd: number;
  costActualUsd?: number;
  dropFolderUrl?: string;
  outputArtifactId?: string;
  artifactId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export interface ProductionProvider {
  readonly id: string;
  readonly capabilities: ProductionCapabilities;

  health(): Promise<ProviderHealth>;
  submitJob(spec: CreativeSpec): Promise<ProductionJob>;
  checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob>;
  cancelJob?(jobId: string): Promise<void>;
}
