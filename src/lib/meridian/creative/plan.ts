/**
 * CreativePlan Types & Schemas
 *
 * Implements Section P0.5, P1.1, P1.2:
 * Strict separation of creationScope and autonomyMode.
 * A validated CreativePlan governs exactly which deliverables and jobs are permitted.
 */

export type CreationScope =
  | "auto_choose"
  | "image_only"
  | "video_only"
  | "carousel_only"
  | "mixed_campaign"
  | "research_only";

export type AutonomyMode =
  | "manual"
  | "semi_automatic"
  | "fully_automatic";

export type CampaignObjective =
  | "awareness"
  | "engagement"
  | "traffic"
  | "conversion"
  | "testing";

export type DeliverableKind = "image" | "video" | "carousel_slide" | "copy_only";

export interface CreativeDeliverable {
  id: string;
  kind: DeliverableKind;
  sequenceIndex: number;
  format: string;
  title: string;
  copy: string;
  altText?: string;
  aspectRatio: string;
  targetDurationSeconds?: number;
  provider: string;
  model: string;
  dependsOnDeliverableIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface DecisionRationale {
  topic: string;
  claim: string;
  groundedIn: "jev_answer" | "evidence_metric" | "brand_constraint" | "policy_rule";
  sourceId: string;
  detail: string;
}

export interface AssetPlanItem {
  assetId: string;
  role: "primary_visual" | "b_roll" | "audio_track" | "reference_frame" | "logo";
  rightsConfirmed: boolean;
  provenance: string;
}

export interface ProductionStep {
  stepId: string;
  deliverableId: string;
  action: "generate_image" | "generate_video" | "compose_carousel" | "reuse_asset";
  providerId: string;
  modelId: string;
  estimatedCostUsd: number;
  requiresPriorStepId?: string;
}

export interface CostEstimate {
  totalEstimatedUsd: number;
  perDeliverableUsd: Record<string, number>;
  isHardCapped: boolean;
  maxSpendUsd?: number;
  currency: "USD";
  label: "PRE_GENERATION_ESTIMATE";
}

export interface ApprovalRequirement {
  id: string;
  level: "human_creative_director" | "compliance_gate" | "spend_threshold";
  status: "pending" | "approved" | "rejected" | "auto_approved";
  reason: string;
  requiredBeforeAction: "production_execution" | "publishing";
}

export interface ProductionFallback {
  primaryProvider: string;
  fallbackProvider: string;
  triggerCondition: "provider_unavailable" | "timeout" | "qc_failure";
  permitted: boolean;
}

export interface AppliedConstraint {
  constraintName: string;
  constraintValue: unknown;
  source: "user_intent" | "brand_guideline" | "platform_spec" | "spend_cap";
}

export interface CreativePlan {
  id: string;
  version: string;
  scope: CreationScope;
  autonomy: AutonomyMode;
  objective: CampaignObjective;
  selectedConceptId: string | null;
  rationale: DecisionRationale[];
  deliverables: CreativeDeliverable[];
  assetPlan: AssetPlanItem[];
  productionPlan: ProductionStep[];
  estimatedCost: CostEstimate;
  approvalRequirements: ApprovalRequirement[];
  fallbackPlan: ProductionFallback[];
  constraintsApplied: AppliedConstraint[];
  whyFormatChosen: string;
  whyOtherFormatsRejected: Record<string, string>;
  createdAt: string;
}
