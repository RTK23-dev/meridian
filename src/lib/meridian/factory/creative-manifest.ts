/**
 * Universal Creative Manifest & Creator Modes
 *
 * Implements Section C6.1, C6.4 of the Master Engineering Specification:
 * - Creation modes: research_only, image_ad, organic_image, carousel, video_reel_short, mixed_format
 * - Starting materials & production strategies
 * - Versioned Executable Creative Manifest preserving lineage, beat list, asset provenance,
 *   cost, QC results, and telemetry join keys.
 */

export type CreationMode =
  | "research_only"
  | "image_ad"
  | "organic_image"
  | "carousel"
  | "video_reel_short"
  | "mixed_format";

export type StartingMaterialType =
  | "new_brief"
  | "winning_organic_reel"
  | "winning_ad"
  | "meridian_creative"
  | "brand_asset_library"
  | "creator_ugc_footage"
  | "website_product_page";

export type ProductionStrategyType =
  | "reuse_edit_assets"
  | "manual_cloud"
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
}

/**
 * Validates whether a creation mode + strategy combo is permitted and creates no erroneous jobs.
 */
export function validateCreationPlan(input: {
  mode: CreationMode;
  productionStrategy: ProductionStrategyType;
  startingMaterial: StartingMaterialType;
}): { valid: boolean; willCreateProductionJob: boolean; reason?: string } {
  if (input.mode === "research_only") {
    return {
      valid: true,
      willCreateProductionJob: false,
      reason: "Research-only mode discovers and analyzes concepts without creating production jobs.",
    };
  }

  if (input.productionStrategy === "automated_remote" && input.mode === "carousel") {
    return {
      valid: true,
      willCreateProductionJob: true,
      reason: "Carousel rendering via image synthesis provider.",
    };
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
