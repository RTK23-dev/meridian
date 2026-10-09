/**
 * Meridian Creative Decision Engine
 *
 * Implements Section P0.5, P1.1, P1.2, and Phase D:
 * Translates JEV semantic judgments, user scope, autonomy mode, assets,
 * and hard constraints into a validated, versioned CreativePlan.
 *
 * Invariant: The executor may submit jobs ONLY for deliverables explicitly
 * listed in the CreativePlan.
 */

import type {
  AppliedConstraint,
  ApprovalRequirement,
  AssetPlanItem,
  CampaignObjective,
  CostEstimate,
  CreationScope,
  CreativeDeliverable,
  CreativePlan,
  CreativePlanStatus,
  CreativeJudgmentBundle,
  DecisionRationale,
  ProductionStep,
  AutonomyMode,
} from "./plan.ts";

export interface CreativeDecisionInput {
  scope: CreationScope;
  autonomy: AutonomyMode;
  objective?: CampaignObjective;
  conceptId?: string;
  brief: {
    title: string;
    hook: string;
    message: string;
    cta: string;
    angle?: string;
    productName?: string;
    aspectRatio?: string;
    targetDurationSeconds?: number;
    decisionId?: string;
  };
  jevJudgments?: CreativeJudgmentBundle | {
    isOutlier?: boolean;
    creativeMechanism?: string;
    transferabilityScore?: number;
    brandFitScore?: number;
    recommendedFormat?: "image" | "video" | "carousel";
    reasons?: string[];
    recommendedFormats?: Array<{ format: "image" | "video" | "carousel"; rationale: string; priority: number }>;
    status?: "admissible" | "abstain_insufficient_evidence" | "abstain_rejected" | "abstain_malformed";
    evidenceRefs?: string[];
    decisionId?: string;
    questionSetVersion?: string;
  };
  constraints?: {
    maxSpendUsd?: number;
    allowedProviders?: string[];
    allowedModels?: string[];
    requireHumanReview?: boolean;
  };
  preferredImageProvider?: string;
  preferredVideoProvider?: string;
  availableAssets?: AssetPlanItem[];
}

export class CreativeDecisionEngine {
  static createPlan(input: CreativeDecisionInput): CreativePlan {
    const planId = `plan-${globalThis.crypto.randomUUID()}`;
    const version = "2026.10.1";
    const objective = input.objective ?? "conversion";
    const scope = input.scope;
    const autonomy = input.autonomy;

    const deliverables: CreativeDeliverable[] = [];
    const productionPlan: ProductionStep[] = [];
    const rationales: DecisionRationale[] = [];
    const constraintsApplied: AppliedConstraint[] = [];
    const whyOtherFormatsRejected: Record<string, string> = {};

    let chosenFormatDesc = "";

    // Record base user constraints
    constraintsApplied.push({
      constraintName: "creationScope",
      constraintValue: scope,
      source: "user_intent",
    });
    constraintsApplied.push({
      constraintName: "autonomyMode",
      constraintValue: autonomy,
      source: "user_intent",
    });

    if (input.constraints?.maxSpendUsd !== undefined) {
      constraintsApplied.push({
        constraintName: "maxSpendUsd",
        constraintValue: input.constraints.maxSpendUsd,
        source: "spend_cap",
      });
    }

    // Determine target format
    let effectiveFormat: "image" | "video" | "carousel" | "mixed" | "research" | "abstain";
    if (input.jevJudgments?.status === "abstain_rejected") {
      effectiveFormat = "abstain";
      chosenFormatDesc = "JEV policy rejected this brief. No production deliverables created.";
      whyOtherFormatsRejected.all_media = "Brief rejected by JEV policy.";
      rationales.push({
        topic: "jev_rejection_block",
        claim: "JEV policy rejected this brief",
        groundedIn: "policy_rule",
        sourceId: input.jevJudgments.decisionId || "jev-rejected",
        detail: "Hard block: JEV decision is REJECT. Creative production is forbidden.",
      });
    } else if (scope === "image_only") {
      effectiveFormat = "image";
      chosenFormatDesc = "User explicitly specified image_only scope.";
      whyOtherFormatsRejected.video = "Excluded by user scope image_only.";
      whyOtherFormatsRejected.carousel = "Excluded by user scope image_only.";
    } else if (scope === "video_only") {
      effectiveFormat = "video";
      chosenFormatDesc = "User explicitly specified video_only scope.";
      whyOtherFormatsRejected.image = "Excluded by user scope video_only.";
      whyOtherFormatsRejected.carousel = "Excluded by user scope video_only.";
    } else if (scope === "carousel_only") {
      effectiveFormat = "carousel";
      chosenFormatDesc = "User explicitly specified carousel_only scope.";
      whyOtherFormatsRejected.video = "Excluded by user scope carousel_only.";
      whyOtherFormatsRejected.single_image = "Excluded by user scope carousel_only.";
    } else if (scope === "mixed_campaign") {
      effectiveFormat = "mixed";
      chosenFormatDesc = "User requested a mixed campaign with video and static variants.";
    } else if (scope === "research_only") {
      effectiveFormat = "research";
      chosenFormatDesc = "Research-only mode selected: zero production deliverables created.";
      whyOtherFormatsRejected.all_media = "Zero deliverables created in research_only mode.";
    } else {
      // auto_choose: rely strictly on JEV judgments (P0-A)
      const judgments = input.jevJudgments;
      const isAdmissible = judgments && (judgments.status === undefined || judgments.status === "admissible");
      const recFormat = judgments?.recommendedFormats?.[0]?.format || (judgments as any)?.recommendedFormat;
      const recRationale = judgments?.recommendedFormats?.[0]?.rationale || (judgments as any)?.reasons?.[0];

      if (!judgments || !isAdmissible || !recFormat) {
        // Explicit Abstention (P0-A: never invent a decision or default to image pretending it was JEV)
        effectiveFormat = "abstain";
        chosenFormatDesc = "JEV abstained: insufficient or unavailable evidence. Format selection deferred to human choice.";
        whyOtherFormatsRejected.video = "JEV provided no admissible evidence-backed recommendation for video.";
        whyOtherFormatsRejected.image = "JEV provided no admissible evidence-backed recommendation for image.";
        whyOtherFormatsRejected.carousel = "JEV provided no admissible evidence-backed recommendation for carousel.";

        rationales.push({
          topic: "format_selection_abstention",
          claim: "Format selection requires explicit human choice",
          groundedIn: "policy_rule",
          sourceId: judgments?.decisionId || input.brief.decisionId || "policy-abstain",
          detail: judgments?.status
            ? `JEV status is '${judgments.status}'. No evidence-backed format recommendation.`
            : "No persisted JEV judgments available for this brief.",
        });
      } else if (recFormat === "video") {
        effectiveFormat = "video";
        chosenFormatDesc = `JEV recommended video: ${recRationale || "Dynamic motion mechanism grounded in evidence."}`;
        whyOtherFormatsRejected.image = "Mechanism requires motion and audio pacing.";
        whyOtherFormatsRejected.carousel = "Mechanism requires single continuous motion narrative.";
      } else if (recFormat === "carousel") {
        effectiveFormat = "carousel";
        chosenFormatDesc = `JEV recommended carousel: ${recRationale || "Multi-step demonstration in evidence."}`;
        whyOtherFormatsRejected.single_image = "Demonstration requires progressive information disclosure.";
        whyOtherFormatsRejected.video = "Step-by-step structure best suited for user-paced swipe carousel.";
      } else {
        effectiveFormat = "image";
        chosenFormatDesc = `JEV recommended static image: ${recRationale || "Concise static visual impact."}`;
        whyOtherFormatsRejected.video = "High production cost with no evidence of motion requirement.";
        whyOtherFormatsRejected.carousel = "Single visual punch without progressive steps.";
      }
    }

    // Grounding rationale from JEV if present
    if (input.jevJudgments?.creativeMechanism) {
      rationales.push({
        topic: "creative_mechanism",
        claim: input.jevJudgments.creativeMechanism,
        groundedIn: "jev_answer",
        sourceId: input.brief.decisionId ?? "jev-default",
        detail: `Preserving core mechanism identified by JEV: ${input.jevJudgments.creativeMechanism}`,
      });
    }

    const imgProvider = (input.preferredImageProvider && input.preferredImageProvider !== "none")
      ? input.preferredImageProvider
      : "google_nano_banana";
    const vidProvider = (input.preferredVideoProvider && input.preferredVideoProvider !== "none")
      ? (input.preferredVideoProvider === "omni" ? "google_omni" : input.preferredVideoProvider)
      : "google_omni";

    // 1. Build Deliverables & Production Steps strictly according to effectiveFormat
    if (effectiveFormat === "image") {
      // EXACTLY ZERO video jobs
      for (let i = 0; i < 3; i++) {
        const delivId = `deliv-img-${i + 1}`;
        deliverables.push({
          id: delivId,
          kind: "image",
          sequenceIndex: i,
          format: "single_image",
          title: `${input.brief.title} - Variant ${i + 1}`,
          copy: `${input.brief.hook}\n${input.brief.message}\n${input.brief.cta}`,
          aspectRatio: input.brief.aspectRatio || "1:1",
          provider: imgProvider as any,
          model: "gemini-nano-banana-2.1",
        });

        productionPlan.push({
          stepId: `step-img-${i + 1}`,
          deliverableId: delivId,
          action: "generate_image",
          providerId: imgProvider,
          modelId: "gemini-nano-banana-2.1",
          estimatedCostUsd: imgProvider.startsWith("test:") ? 0 : 0.05,
        });
      }
    } else if (effectiveFormat === "video") {
      // EXACTLY ZERO image deliverable jobs
      const delivId = "deliv-video-1";
      const targetSec = input.brief.targetDurationSeconds ?? 8;
      deliverables.push({
        id: delivId,
        kind: "video",
        sequenceIndex: 0,
        format: "video_ugc",
        title: `${input.brief.title} - Video Reel`,
        copy: `${input.brief.hook}\n${input.brief.message}\n${input.brief.cta}`,
        aspectRatio: input.brief.aspectRatio || "9:16",
        targetDurationSeconds: targetSec,
        provider: vidProvider as any,
        model: "gemini-omni-1.1-flash",
      });

      productionPlan.push({
        stepId: "step-video-1",
        deliverableId: delivId,
        action: "generate_video",
        providerId: vidProvider,
        modelId: "gemini-omni-1.1-flash",
        estimatedCostUsd: vidProvider.startsWith("test:") ? 0 : Number((targetSec * 0.15).toFixed(2)),
      });
    } else if (effectiveFormat === "carousel") {
      // EXACTLY ZERO video jobs; N slide deliverables
      const slides = [
        "Slide 1: Hook / Problem",
        "Slide 2: Agitation / Demo",
        "Slide 3: Solution / Transformation",
        "Slide 4: Offer / CTA",
      ];
      for (let i = 0; i < slides.length; i++) {
        const delivId = `deliv-slide-${i + 1}`;
        deliverables.push({
          id: delivId,
          kind: "carousel_slide",
          sequenceIndex: i,
          format: `carousel_slide_${i + 1}`,
          title: `${input.brief.title} - ${slides[i]}`,
          copy: i === 0 ? input.brief.hook : i === 3 ? input.brief.cta : input.brief.message,
          altText: slides[i],
          aspectRatio: "1:1",
          provider: imgProvider as any,
          model: "gemini-nano-banana-2.1",
        });

        productionPlan.push({
          stepId: `step-slide-${i + 1}`,
          deliverableId: delivId,
          action: "generate_image",
          providerId: imgProvider,
          modelId: "gemini-nano-banana-2.1",
          estimatedCostUsd: imgProvider.startsWith("test:") ? 0 : 0.05,
        });
      }
    } else if (effectiveFormat === "mixed") {
      // 1 Video + 3 Carousel Slides + 2 Image Variants
      const vidDelivId = "deliv-mixed-vid";
      deliverables.push({
        id: vidDelivId,
        kind: "video",
        sequenceIndex: 0,
        format: "video_ugc",
        title: `${input.brief.title} - Main Video`,
        copy: input.brief.hook,
        aspectRatio: "9:16",
        targetDurationSeconds: 8,
        provider: vidProvider as any,
        model: "gemini-omni-1.1-flash",
      });
      productionPlan.push({
        stepId: "step-mixed-vid",
        deliverableId: vidDelivId,
        action: "generate_video",
        providerId: vidProvider,
        modelId: "gemini-omni-1.1-flash",
        estimatedCostUsd: vidProvider.startsWith("test:") ? 0 : 1.20,
      });

      for (let i = 0; i < 3; i++) {
        const slideId = `deliv-mixed-slide-${i + 1}`;
        deliverables.push({
          id: slideId,
          kind: "carousel_slide",
          sequenceIndex: i + 1,
          format: `carousel_slide_${i + 1}`,
          title: `${input.brief.title} - Slide ${i + 1}`,
          copy: input.brief.message,
          aspectRatio: "1:1",
          provider: imgProvider as any,
          model: "gemini-nano-banana-2.1",
        });
        productionPlan.push({
          stepId: `step-mixed-slide-${i + 1}`,
          deliverableId: slideId,
          action: "generate_image",
          providerId: imgProvider,
          modelId: "gemini-nano-banana-2.1",
          estimatedCostUsd: imgProvider.startsWith("test:") ? 0 : 0.05,
        });
      }

      for (let i = 0; i < 2; i++) {
        const imgId = `deliv-mixed-img-${i + 1}`;
        deliverables.push({
          id: imgId,
          kind: "image",
          sequenceIndex: i + 4,
          format: "single_image",
          title: `${input.brief.title} - Image Ad ${i + 1}`,
          copy: input.brief.cta,
          aspectRatio: "1:1",
          provider: imgProvider as any,
          model: "gemini-nano-banana-2.1",
        });
        productionPlan.push({
          stepId: `step-mixed-img-${i + 1}`,
          deliverableId: imgId,
          action: "generate_image",
          providerId: imgProvider,
          modelId: "gemini-nano-banana-2.1",
          estimatedCostUsd: imgProvider.startsWith("test:") ? 0 : 0.05,
        });
      }
    } else {
      // research_only: zero deliverables, zero production steps
    }

    // Cost calculation
    const perDeliverableUsd: Record<string, number> = {};
    let totalEstimatedUsd = 0;
    for (const step of productionPlan) {
      perDeliverableUsd[step.deliverableId] = (perDeliverableUsd[step.deliverableId] || 0) + step.estimatedCostUsd;
      totalEstimatedUsd += step.estimatedCostUsd;
    }
    totalEstimatedUsd = Number(totalEstimatedUsd.toFixed(2));

    const estimatedCost: CostEstimate = {
      totalEstimatedUsd,
      perDeliverableUsd,
      isHardCapped: Boolean(input.constraints?.maxSpendUsd !== undefined),
      maxSpendUsd: input.constraints?.maxSpendUsd,
      currency: "USD",
      label: "PRE_GENERATION_ESTIMATE",
    };

    // Approval requirements based on autonomy mode
    const approvalRequirements: ApprovalRequirement[] = [];

    let planStatus: CreativePlanStatus = "draft";

    if (input.jevJudgments?.status === "abstain_rejected") {
      planStatus = "rejected";
      approvalRequirements.push({
        id: `appr-reject-${planId}`,
        level: "compliance_gate",
        status: "rejected",
        reason: "JEV policy rejected this brief. Creative production is blocked.",
        requiredBeforeAction: "production_execution",
      });
    } else if (effectiveFormat === "abstain") {
      planStatus = "abstained";
      approvalRequirements.push({
        id: `appr-abstain-${planId}`,
        level: "human_creative_director",
        status: "pending",
        reason: "JEV abstained due to missing or insufficient evidence. User must explicitly select format.",
        requiredBeforeAction: "production_execution",
      });
    } else if (autonomy === "manual") {
      planStatus = "draft";
      approvalRequirements.push({
        id: `appr-manual-${planId}`,
        level: "human_creative_director",
        status: "pending",
        reason: "Manual autonomy requires explicit human approval before any billable generation.",
        requiredBeforeAction: "production_execution",
      });
    } else if (autonomy === "semi_automatic") {
      planStatus = "awaiting_approval";
      approvalRequirements.push({
        id: `appr-semiauto-${planId}`,
        level: "human_creative_director",
        status: "pending",
        reason: "Semi-automatic autonomy presents plan for confirmation before billable calls.",
        requiredBeforeAction: "production_execution",
      });
    } else {
      // fully_automatic
      const maxSpend = input.constraints?.maxSpendUsd ?? 10.0;
      if (totalEstimatedUsd > maxSpend) {
        planStatus = "awaiting_approval";
        approvalRequirements.push({
          id: `appr-spend-${planId}`,
          level: "spend_threshold",
          status: "pending",
          reason: `Total cost ($${totalEstimatedUsd}) exceeds spend cap ($${maxSpend}).`,
          requiredBeforeAction: "production_execution",
        });
      } else if (input.constraints?.requireHumanReview) {
        planStatus = "awaiting_approval";
        approvalRequirements.push({
          id: `appr-policy-${planId}`,
          level: "compliance_gate",
          status: "pending",
          reason: "Brand policy explicitly requires human review for this campaign.",
          requiredBeforeAction: "production_execution",
        });
      } else {
        planStatus = "approved";
        approvalRequirements.push({
          id: `appr-auto-${planId}`,
          level: "spend_threshold",
          status: "auto_approved",
          reason: "Within spend cap and policy rules for fully automatic execution.",
          requiredBeforeAction: "production_execution",
        });
      }
    }

    if (input.jevJudgments && "evidenceRefs" in input.jevJudgments && input.jevJudgments.evidenceRefs?.length) {
      rationales.push({
        topic: "jev_evidence_grounding",
        claim: "Judgments grounded in observed evidence",
        groundedIn: "jev_answer",
        sourceId: input.jevJudgments.decisionId || input.brief.decisionId || "jev-evidence",
        detail: `Evidence refs: ${input.jevJudgments.evidenceRefs.join(", ")} (Question Set: ${input.jevJudgments.questionSetVersion || "v1"})`,
      });
    }

    return {
      id: planId,
      version,
      status: planStatus,
      scope,
      autonomy,
      objective,
      selectedConceptId: input.conceptId || null,
      rationale: rationales,
      deliverables,
      assetPlan: input.availableAssets || [],
      productionPlan,
      estimatedCost,
      approvalRequirements,
      fallbackPlan: [
        {
          primaryProvider: "google_omni",
          fallbackProvider: "higgsfield",
          triggerCondition: "provider_unavailable",
          permitted: true,
        },
      ],
      constraintsApplied,
      whyFormatChosen: chosenFormatDesc,
      whyOtherFormatsRejected,
      createdAt: new Date().toISOString(),
    };
  }
}
