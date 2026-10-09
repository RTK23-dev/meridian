/**
 * Universal Creative Manifest & Creator Modes
 *
 * Implements Section C6.1, C6.4 of the Master Engineering Specification:
 * - Creation modes: research_only, image_ad, organic_image, carousel, video_reel_short, mixed_format
 * - Starting materials & production strategies
 * - Versioned Executable Creative Manifest preserving lineage, beat list, asset provenance,
 *   cost, QC results, and telemetry join keys.
 */

import type {
  CreativePlan,
  CreativeDeliverable,
  DeliverableKind,
  AppliedConstraint,
  ApprovalRequirement,
} from "../creative/plan.ts";

export type CreationMode =
  | "research_only"
  | "image_ad"
  | "organic_image"
  | "carousel"
  | "video_reel_short"
  | "video"
  | "mixed_format"
  | "mixed_campaign";

export type StartingMaterialType =
  | "new_brief"
  | "winning_reference"
  | "winning_organic_reel"
  | "winning_ad"
  | "meridian_creative"
  | "brand_assets"
  | "brand_asset_library"
  | "creator_ugc_footage"
  | "website_product_page";

export type ProductionStrategyType =
  | "reuse_edit_assets"
  | "edit_existing_assets"
  | "manual_cloud"
  | "automated_provider"
  | "automated_remote"
  | "hybrid"
  | "image_carousel_render";

export type AssetProvenanceBasis =
  | "USER_PROVIDED"
  | "BRAND_OWNED"
  | "LICENSED"
  | "AI_GENERATED";

export interface CreativeManifestBeat {
  id: string;
  purpose: string;
  targetDurationSeconds?: number;
  startMs?: number;
  endMs?: number;
  visualInstruction: string;
  scriptOrCaption?: string;
  onScreenText?: string;
  assetRef?: string;
  requiredEvidence?: string[];
}

export interface CreativeManifestAsset {
  assetId: string;
  type: "footage" | "image" | "audio" | "layer";
  provenance: AssetProvenanceBasis;
  licenseBasis?: string;
  consentBasis?: string;
  checksum?: string;
  sourceUrl?: string;
}

export interface CreativeManifestLayer {
  layerId: string;
  provider: string;
  model?: string;
  promptVersion?: string;
}

export interface CreativeManifestQC {
  status: "APPROVED" | "REJECTED" | "HUMAN_REVIEW" | "PENDING";
  checks: {
    claimsVerified?: boolean;
    originalityPassed?: boolean;
    rightsCleared?: boolean;
    craftAndSlopPassed?: boolean;
    aspectRatioCompliant?: boolean;
  };
  notes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface CreativeManifest {
  creativeId: string;
  version: string;
  conceptId: string;
  conceptVersion: string;
  mode: CreationMode;
  startingMaterial: StartingMaterialType;
  productionStrategy: ProductionStrategyType;
  brand: {
    organizationId: string;
    brandId: string;
    product: string;
    audience: string;
    objective: string;
  };
  format: {
    channel: "instagram" | "tiktok" | "youtube" | "meta_ads" | "multi_channel";
    aspectRatio: "9:16" | "16:9" | "1:1" | "4:5";
    targetDurationSeconds?: number;
    slideCount?: number;
  };
  beats: CreativeManifestBeat[];
  assets: CreativeManifestAsset[];
  layers: CreativeManifestLayer[];
  cost: {
    estimateUsd: number;
    actualUsd?: number;
  };
  qc: CreativeManifestQC;
  outputArtifacts: Array<{
    artifactId: string;
    checksum?: string;
    mimeType: string;
    storageKey?: string;
  }>;
  publishedPostIds: string[];
  telemetryJoinKeys: Record<string, string>;
  createdAt: string;
  updatedAt: string;

  // Semantic decision projections preserved from CreativePlan & CreativeDeliverable
  deliverableId?: string;
  deliverableType?: DeliverableKind;
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
  production?: {
    provider: string;
    model: string;
    requestedProvider?: string;
    requestedModel?: string;
    fallbackUsed?: boolean;
    fallbackReason?: string;
  };
  constraints?: AppliedConstraint[];
  qcRequirements?: ApprovalRequirement[];
}

/**
 * Validates whether a creation mode + strategy combo is permitted and creates no erroneous jobs.
 */
export function validateCreationPlan(input: {
  mode: CreationMode;
  productionStrategy: ProductionStrategyType;
  startingMaterial: StartingMaterialType;
  slideCount?: number;
  beats?: CreativeManifestBeat[];
}): { valid: boolean; willCreateProductionJob: boolean; reason?: string } {
  if (input.mode === "research_only") {
    return {
      valid: true,
      willCreateProductionJob: false,
      reason: "Research-only mode discovers and analyzes concepts without creating production jobs.",
    };
  }

  if (input.mode === "carousel") {
    if (input.slideCount !== undefined && input.slideCount < 2) {
      return {
        valid: false,
        willCreateProductionJob: false,
        reason: "Carousel mode requires at least 2 coherent slides.",
      };
    }
    return {
      valid: true,
      willCreateProductionJob: true,
      reason: "Carousel rendering via image synthesis provider.",
    };
  }

  if (input.mode === "video" || input.mode === "video_reel_short") {
    if (input.beats !== undefined && input.beats.length === 0) {
      return {
        valid: false,
        willCreateProductionJob: false,
        reason: "Video creation requires a non-empty shot or beat plan.",
      };
    }
  }

  return {
    valid: true,
    willCreateProductionJob: true,
  };
}

/**
 * Creates a validated, executable CreativeManifest.
 */
export function buildCreativeManifest(params: {
  creativeId: string;
  conceptId: string;
  mode: CreationMode;
  startingMaterial: StartingMaterialType;
  productionStrategy: ProductionStrategyType;
  brand: {
    organizationId: string;
    brandId: string;
    product: string;
    audience: string;
    objective: string;
  };
  format: {
    channel: "instagram" | "tiktok" | "youtube" | "meta_ads" | "multi_channel";
    aspectRatio: "9:16" | "16:9" | "1:1" | "4:5";
    targetDurationSeconds?: number;
    slideCount?: number;
  };
  beats: CreativeManifestBeat[];
  assets?: CreativeManifestAsset[];
  costEstimateUsd?: number;
}): CreativeManifest {
  const plan = validateCreationPlan({
    mode: params.mode,
    productionStrategy: params.productionStrategy,
    startingMaterial: params.startingMaterial,
  });

  if (!plan.valid) {
    throw new Error(`Invalid creation plan: ${plan.reason}`);
  }

  const now = new Date().toISOString();

  return {
    creativeId: params.creativeId,
    version: "1.0.0",
    conceptId: params.conceptId,
    conceptVersion: "1.0.0",
    mode: params.mode,
    startingMaterial: params.startingMaterial,
    productionStrategy: params.productionStrategy,
    brand: params.brand,
    format: params.format,
    beats: params.beats,
    assets: params.assets ?? [],
    layers: [],
    cost: {
      estimateUsd: params.costEstimateUsd ?? 0.0,
    },
    qc: {
      status: "PENDING",
      checks: {},
    },
    outputArtifacts: [],
    publishedPostIds: [],
    telemetryJoinKeys: {
      utm_campaign: `${params.brand.brandId}_${params.conceptId}`,
      utm_content: params.creativeId,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Pure deterministic projection: transforms a CreativePlan and one of its deliverables
 * into an executable CreativeManifest without re-consulting the brief or invoking JEV.
 *
 * Invariant: All creative decisions made in the plan (hook, mechanism, scenes, assets,
 * duration, aspect ratio, provider, model, constraints) survive unmodified.
 */
export function manifestFromCreativePlan(
  plan: CreativePlan,
  deliverable: CreativeDeliverable,
  options?: {
    organizationId?: string;
    brandId?: string;
    productName?: string;
    audience?: string;
    checkProviderAvailability?: (provider: string) => boolean;
  }
): CreativeManifest {
  // 1. Resolve Provider via fallback plan if primary provider is unavailable
  let resolvedProvider = deliverable.provider;
  let resolvedModel = deliverable.model;
  let fallbackUsed = false;
  let fallbackReason: string | undefined;

  if (options?.checkProviderAvailability && !options.checkProviderAvailability(deliverable.provider)) {
    const fallback = plan.fallbackPlan?.find(
      (f) => f.primaryProvider === deliverable.provider && f.permitted
    );
    if (fallback) {
      resolvedProvider = fallback.fallbackProvider;
      if (!fallback.fallbackModel) {
        throw new Error(`Fallback provider '${fallback.fallbackProvider}' has no paired fallback model in CreativePlan.`);
      }
      resolvedModel = fallback.fallbackModel;
      fallbackUsed = true;
      fallbackReason = fallback.triggerCondition;
    } else {
      throw new Error(`Provider '${deliverable.provider}' is unavailable and no permitted fallback is configured in CreativePlan.`);
    }
  }

  // 2. Map mode
  let mode: CreationMode;
  if (deliverable.kind === "video") {
    mode = "video";
  } else if (deliverable.kind === "carousel_slide") {
    mode = "carousel";
  } else if (deliverable.kind === "image") {
    mode = "image_ad";
  } else {
    mode = "research_only";
  }

  // 3. Map Beats from deliverable scenes or copy
  let beats: CreativeManifestBeat[] = [];
  if (deliverable.scenes && deliverable.scenes.length > 0) {
    beats = deliverable.scenes.map((scene, idx) => ({
      id: scene.id || `scene-${idx + 1}`,
      purpose: scene.description || `Scene ${idx + 1}`,
      targetDurationSeconds: scene.durationSeconds,
      visualInstruction: scene.visualInstruction || scene.description,
      scriptOrCaption: scene.scriptOrCaption,
      onScreenText: scene.onScreenText,
    }));
  } else if (deliverable.kind === "video") {
    beats = [
      {
        id: "hero",
        purpose: "Visual Hook & Core Value Proposition",
        targetDurationSeconds: deliverable.targetDurationSeconds || 6,
        visualInstruction: deliverable.visualDirection || deliverable.title,
        scriptOrCaption: deliverable.copy,
        onScreenText: deliverable.onScreenText || deliverable.title,
      },
    ];
  } else {
    beats = [
      {
        id: `deliverable-${deliverable.sequenceIndex}`,
        purpose: deliverable.title,
        visualInstruction: deliverable.visualDirection || deliverable.title,
        scriptOrCaption: deliverable.copy,
        onScreenText: deliverable.onScreenText || deliverable.title,
      },
    ];
  }

  // 4. Map Assets from plan.assetPlan
  const assets: CreativeManifestAsset[] = (plan.assetPlan || []).map((a) => ({
    assetId: a.assetId,
    type: a.role === "audio_track" ? "audio" : a.role === "b_roll" ? "footage" : "image",
    provenance: a.provenance === "USER_PROVIDED" ? "USER_PROVIDED" : a.provenance === "AI_GENERATED" ? "AI_GENERATED" : "BRAND_OWNED",
  }));

  // 5. Cost
  const costEstimateUsd = plan.estimatedCost?.perDeliverableUsd?.[deliverable.id] ??
    (plan.estimatedCost?.totalEstimatedUsd ? plan.estimatedCost.totalEstimatedUsd / (plan.deliverables.length || 1) : 0);

  const now = new Date().toISOString();

  // 6. Project Manifest
  const manifest: CreativeManifest = {
    creativeId: deliverable.id,
    version: plan.version,
    conceptId: plan.selectedConceptId || plan.id,
    conceptVersion: plan.version,
    mode,
    startingMaterial: "new_brief",
    productionStrategy: "automated_provider",
    brand: {
      organizationId: options?.organizationId || "tenant-default",
      brandId: options?.brandId || "brand-default",
      product: options?.productName || "Product",
      audience: options?.audience || "Target Audience",
      objective: plan.objective,
    },
    format: {
      channel: "multi_channel",
      aspectRatio: (deliverable.aspectRatio as any) || "9:16",
      targetDurationSeconds: deliverable.targetDurationSeconds,
      slideCount: deliverable.kind === "carousel_slide" ? plan.deliverables.filter(d => d.kind === "carousel_slide").length : undefined,
    },
    beats,
    assets,
    layers: [
      {
        layerId: "main-synthesis",
        provider: resolvedProvider,
        model: resolvedModel,
      },
    ],
    cost: {
      estimateUsd: costEstimateUsd,
    },
    // No QC check has run when the manifest is built. Absent flags mean "not run", never "passed".
    qc: {
      status: "PENDING",
      checks: {},
    },
    outputArtifacts: [],
    publishedPostIds: [],
    telemetryJoinKeys: {
      planId: plan.id,
      deliverableId: deliverable.id,
      conceptId: plan.selectedConceptId || plan.id,
    },
    createdAt: plan.createdAt || now,
    updatedAt: now,

    // Explicit preserved deliverable decisions
    deliverableId: deliverable.id,
    deliverableType: deliverable.kind,
    hook: deliverable.hook || {
      type: deliverable.metadata?.hookType,
      text: deliverable.metadata?.hookText || deliverable.title,
      visual: deliverable.metadata?.hookVisual,
    },
    concept: deliverable.concept || {
      mechanism: deliverable.metadata?.mechanism || plan.rationale?.[0]?.claim,
      theme: deliverable.metadata?.theme,
    },
    scenes: deliverable.scenes || beats.map((b) => ({
      id: b.id,
      description: b.purpose,
      durationSeconds: b.targetDurationSeconds,
      visualInstruction: b.visualInstruction,
      scriptOrCaption: b.scriptOrCaption,
      onScreenText: b.onScreenText,
    })),
    shots: deliverable.shots || [],
    dialogue: deliverable.dialogue,
    narration: deliverable.narration,
    onScreenText: deliverable.onScreenText,
    visualDirection: deliverable.visualDirection,
    audioDirection: deliverable.audioDirection,
    production: {
      provider: resolvedProvider,
      model: resolvedModel,
      requestedProvider: deliverable.provider,
      requestedModel: deliverable.model,
      fallbackUsed,
      fallbackReason,
    },
    constraints: plan.constraintsApplied || [],
    qcRequirements: plan.approvalRequirements || [],
  };

  return manifest;
}

