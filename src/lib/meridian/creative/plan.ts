import type { PlanLineage } from "./lineage.ts";

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

export type CreativePlanStatus =
  | "draft"
  | "ready_for_approval"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled"
  | "abstained"
  | "rejected";

export interface CreativeFormatRecommendation {
  format: "image" | "video" | "carousel";
  rationale: string;
  priority: number;
}

export interface CreativeJudgmentBundle {
  conceptStrengthScore?: number;
  isOutlier?: boolean;
  creativeMechanism?: string;
  recommendedFormats: CreativeFormatRecommendation[];
  formatSuitability: Record<string, { suitable: boolean; rationale: string }>;
  brandFitScore?: number;
  transferabilityScore?: number;
  creatorDependency?: boolean;
  distributionSuitability?: "paid_only" | "organic_only" | "both";
  status: "admissible" | "abstain_insufficient_evidence" | "abstain_rejected" | "abstain_malformed";
  evidenceRefs: string[];
  decisionId: string;
  questionSetVersion: string;
  provider: string;
  model: string;
}

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
  metadata?: Record<string, any>;
  hook?: {
    type?: string;
    text?: string;
    visual?: string;
  };
  concept?: {
    mechanism?: string;
    theme?: string;
  };
  scenes?: Array<{
    id?: string;
    description: string;
    durationSeconds?: number;
    visualInstruction?: string;
    scriptOrCaption?: string;
    onScreenText?: string;
  }>;
  shots?: any[];
  dialogue?: string;
  narration?: string;
  onScreenText?: string;
  visualDirection?: string;
  audioDirection?: string;
  assets?: any[];
  assetRequirements?: any[];
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
  /** Null when no price is known. An unknown price is never recorded as zero or estimated from another price. */
  estimatedCostUsd: number | null;
  requiresPriorStepId?: string;
}

export interface CostEstimate {
  /** Sum of the known step estimates only. Unpriced deliverables are listed separately, never folded in. */
  totalEstimatedUsd: number;
  perDeliverableUsd: Record<string, number>;
  /** Deliverables with no known price. Absent or empty means every deliverable is priced. */
  unpricedDeliverableIds?: string[];
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
  fallbackModel: string;
  triggerCondition: "provider_unavailable" | "timeout" | "qc_failure";
  permitted: boolean;
}

export interface AppliedConstraint {
  constraintName: string;
  constraintValue: any;
  source: "user_intent" | "brand_guideline" | "platform_spec" | "spend_cap";
}

/**
 * What production needs from the brief, copied when the plan is made. Production reads this snapshot, never the brief row,
 * so a brief edited after planning cannot change what a plan produces (P3c).
 */
export interface PlanProductionContext {
  title: string;
  audience: string;
  angle: string;
  productName: string;
  opportunityId: string | null;
}

export interface CreativePlan {
  id: string;
  version: string;
  status: CreativePlanStatus;
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
  /** The persisted JEV decision and evidence refs this plan was produced under (lineage.ts). */
  lineage: PlanLineage;
  /** The brief snapshot production runs on. Null for a plan made without one, which production refuses. */
  productionContext: PlanProductionContext | null;
}
