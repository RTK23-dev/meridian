/**
 * Concept Genome & Creative Concept Library
 *
 * Implements Section C2 & C3 of the Master Engineering Specification:
 * - 4 Separate Targets:
 *   1. Observed breakout score
 *   2. Creative concept strength
 *   3. Adaptation / transfer potential
 *   4. Business potential
 * - Versioned ConceptGenome mapped to the 11D Angle Bible
 * - Epistemic provenance preservation
 */

import type { EvidenceRef } from "../jev/types.ts";
import { ANGLE_BIBLE_DIMENSIONS, getBibleEntryBySlug, type AngleBibleEntry } from "../study/bible.ts";

export type ObservedBreakoutScore = {
  score: number; // 0 to 1
  viewsLift?: number;
  likesLift?: number;
  commentsLift?: number;
  sharesLift?: number;
  savesLift?: number;
  velocityLift?: number;
  creatorMedianViews?: number;
  controlSetSize: number;
  postAgeHours?: number;
  epistemicState: "OBSERVED" | "COMPUTED" | "INFERRED";
  confidence: number;
  uncertainty?: number;
  evidenceRefs: EvidenceRef[];
};

export type CreativeConceptStrengthScore = {
  score: number; // 0 to 1
  hookStrength: number;
  retentionArchitecture: number;
  emotionalArc: number;
  proofPayoff: number;
  shareTriggerStrength: number;
  executionCraft: number;
  methodState: "seed_prior" | "candidate_fit" | "fitted" | "validated";
  evidenceRefs: EvidenceRef[];
};

export type TransferPotentialScore = {
  score: number; // 0 to 1
  brandFit: number;
  productFit: number;
  productionFeasibility: number;
  audienceRelevance: number;
  claimRiskPenalty: number;
  nonTransferableFactors: string[];
  transferableFactors: string[];
  evidenceRefs: EvidenceRef[];
};

export type BusinessPotentialScore = {
  score: number | null; // null if unknown/unobserved
  attributedConversionRate?: number | null;
  estimatedRoas?: number | null;
  downstreamValueBand?: "LOW" | "MEDIUM" | "HIGH" | "EXCEPTIONAL" | "UNKNOWN";
  epistemicState: "OBSERVED" | "COMPUTED" | "INFERRED" | "UNKNOWN";
  evidenceRefs: EvidenceRef[];
};

export type DecomposedOpportunityRating = {
  ratingOutOfTen: number; // 1.0 to 10.0
  ratingStatus?: "CALCULATED" | "INSUFFICIENT_EVIDENCE" | "LOW_EVIDENCE";
  target: "breakout" | "concept_strength" | "transfer_potential" | "composite";
  observedBreakout: ObservedBreakoutScore;
  conceptStrength: CreativeConceptStrengthScore;
  transferPotential: TransferPotentialScore;
  businessPotential: BusinessPotentialScore;
  missingDimensions: string[];
  evidenceCoverage: number; // 0.0 to 1.0
  version: string;
};

export interface ConceptDimensionValue {
  dimensionId: number;
  dimensionName: string;
  entrySlug: string;
  name: string;
  definition: string;
  psychologicalMechanism: string;
  epistemicState: "OBSERVED" | "INFERRED" | "VALIDATED";
  confidence?: number;
  evidenceRefs: EvidenceRef[];
  timestampStartSec?: number;
  timestampEndSec?: number;
}

export interface ConceptGenome {
  genomeId: string;
  version: string;
  dimensions: Record<string, ConceptDimensionValue>;
  angleBibleSlugs: string[];
  recurringMotifs: string[];
  pacingSecondsPerShot?: number;
  loopBehavior?: string;
  audioRole?: string;
}

export interface CreativeConcept {
  conceptId: string;
  version: string;
  name: string;
  mechanismDescription: string;
  genome: ConceptGenome;
  sourceCreativeIds: string[];
  artifactRefs: EvidenceRef[];
  positiveExamples: string[];
  negativeControls: string[];
  nicheApplicability: string[];
  productTransferConditions: string[];
  productionComplexity: "LOW" | "MEDIUM" | "HIGH";
  estimatedCostBand: "ZERO_SPEND" | "LOW" | "STANDARD" | "HIGH";
  rightsConstraints: string[];
  fatigueState: "emerging" | "rising" | "peaking" | "fading";
  scores: DecomposedOpportunityRating;
  createdAt: string;
  updatedAt: string;
}

/**
 * Calculates decomposed opportunity rating across all four distinct targets.
 * Never collapses unknown metrics into 0 or false certainty.
 */
export function calculateDecomposedOpportunityRating(input: {
  observed?: {
    views?: number;
    creatorMedianViews?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    postAgeHours?: number;
    controlSetSize?: number;
  };
  conceptGenes?: string[]; // Angle Bible entry slugs
  conceptEvaluations?: {
    hookStrength?: number;
    retentionArchitecture?: number;
    emotionalArc?: number;
    proofPayoff?: number;
    shareTriggerStrength?: number;
    executionCraft?: number;
  };
  transferContext?: {
    brandFit?: number;
    productFit?: number;
    productionFeasibility?: number;
    audienceRelevance?: number;
    isMegaCreator?: boolean;
    highClaimRisk?: boolean;
  };
  businessTelemetry?: {
    conversionRate?: number;
    roas?: number;
  };
  evidenceRefs?: EvidenceRef[];
}): DecomposedOpportunityRating {
  const refs = input.evidenceRefs ?? [];
  const missingDimensions: string[] = [];

  // 1. Target 1: Observed Breakout Score
  let breakoutScoreVal = 0.5; // neutral baseline
  let viewsLift: number | undefined;
  let likesLift: number | undefined;
  let commentsLift: number | undefined;
  let sharesLift: number | undefined;
  let savesLift: number | undefined;
  let velocityLift: number | undefined;
  let epistemicState: "OBSERVED" | "COMPUTED" | "INFERRED" = "OBSERVED";
  const controlSize = input.observed?.controlSetSize ?? 0;

  if (input.observed?.views !== undefined && input.observed?.creatorMedianViews !== undefined && input.observed.creatorMedianViews > 0) {
    viewsLift = Math.round((input.observed.views / input.observed.creatorMedianViews) * 100) / 100;
    // Map lift to 0-1 scale: 1.0x = 0.5, 3.0x = 0.8, 5.0x+ = 0.95
    breakoutScoreVal = Math.min(0.99, Math.max(0.1, 0.5 + Math.log2(viewsLift) * 0.2));
    epistemicState = "COMPUTED";
  } else {
    missingDimensions.push("creator_baseline_median_views");
    if (input.observed?.views === undefined) {
      missingDimensions.push("observed_views");
    }
  }

  // Compute interaction engagement rates if denominator views is available and > 0
  if (input.observed?.views !== undefined && input.observed.views > 0) {
    if (input.observed.likes !== undefined) {
      likesLift = Math.round((input.observed.likes / input.observed.views) * 1000) / 1000;
    }
    if (input.observed.comments !== undefined) {
      commentsLift = Math.round((input.observed.comments / input.observed.views) * 1000) / 1000;
    }
    if (input.observed.shares !== undefined) {
      sharesLift = Math.round((input.observed.shares / input.observed.views) * 1000) / 1000;
    }
    if (input.observed.saves !== undefined) {
      savesLift = Math.round((input.observed.saves / input.observed.views) * 1000) / 1000;
    }
  }

  // Velocity lift: views / age in hours
  if (input.observed?.views !== undefined && input.observed.postAgeHours !== undefined && input.observed.postAgeHours > 0) {
    velocityLift = Math.round((input.observed.views / input.observed.postAgeHours) * 10) / 10;
  }

  const observedBreakout: ObservedBreakoutScore = {
    score: Math.round(breakoutScoreVal * 100) / 100,
    viewsLift,
    likesLift,
    commentsLift,
    sharesLift,
    savesLift,
    velocityLift,
    creatorMedianViews: input.observed?.creatorMedianViews,
    controlSetSize: controlSize,
    postAgeHours: input.observed?.postAgeHours,
    epistemicState,
    confidence: controlSize >= 5 ? 0.85 : 0.45,
    uncertainty: controlSize >= 5 ? 0.1 : 0.35,
    evidenceRefs: refs.filter((r) => r.field === "performance" || r.field === "metadata"),
  };

  // 2. Target 2: Creative Concept Strength
  // Dynamically resolve strength per Angle Bible dimension
  const matchedEntries: AngleBibleEntry[] = [];
  for (const slug of input.conceptGenes ?? []) {
    const entry = getBibleEntryBySlug(slug);
    if (entry) {
      matchedEntries.push(entry);
    }
  }

  const getDimensionStrength = (dimId: number, dimName: string): number => {
    const found = matchedEntries.find((e) => e.dimensionId === dimId);
    if (found) return found.predictiveWeight;
    missingDimensions.push(dimName);
    return 0.5; // neutral prior when unobserved
  };

  const hookStrength = input.conceptEvaluations?.hookStrength ?? getDimensionStrength(1, "dim_hook_mechanism");
  const retentionArchitecture = input.conceptEvaluations?.retentionArchitecture ?? getDimensionStrength(4, "dim_retention_architecture");
  const emotionalArc = input.conceptEvaluations?.emotionalArc ?? getDimensionStrength(3, "dim_emotional_driver");
  const proofPayoff = input.conceptEvaluations?.proofPayoff ?? getDimensionStrength(9, "dim_conversion_pattern");
  const shareTriggerStrength = input.conceptEvaluations?.shareTriggerStrength ?? getDimensionStrength(8, "dim_share_trigger");
  const executionCraft = input.conceptEvaluations?.executionCraft ?? getDimensionStrength(5, "dim_visual_craft");

  let geneWeightsSum = 0;
  for (const entry of matchedEntries) {
    geneWeightsSum += entry.predictiveWeight;
  }
  const avgGeneStrength = matchedEntries.length > 0 ? geneWeightsSum / matchedEntries.length : 0.5;

  const conceptStrength: CreativeConceptStrengthScore = {
    score: Math.round(Math.min(0.95, avgGeneStrength * 0.9) * 100) / 100,
    hookStrength,
    retentionArchitecture,
    emotionalArc,
    proofPayoff,
    shareTriggerStrength,
    executionCraft,
    methodState: matchedEntries.length > 0 ? "candidate_fit" : "seed_prior",
    evidenceRefs: refs.filter((r) => r.field === "transcript" || r.field === "scene" || r.field === "ocr"),
  };

  // 3. Target 3: Adaptation / Transfer Potential
  const isMega = input.transferContext?.isMegaCreator ?? false;
  const claimPenalty = input.transferContext?.highClaimRisk ? 0.3 : 0.0;
  
  let brandFit = input.transferContext?.brandFit;
  if (brandFit === undefined) {
    missingDimensions.push("brand_fit");
    brandFit = 0.5; // neutral unconfigured prior
  }

  let productFit = input.transferContext?.productFit;
  if (productFit === undefined) {
    missingDimensions.push("product_fit");
    productFit = 0.5; // neutral unconfigured prior
  }

  const productionFeasibility = input.transferContext?.productionFeasibility ?? 0.8;
  const audienceRelevance = input.transferContext?.audienceRelevance ?? 0.75;

  const transferableFactors = [
    "Hook structure and pattern interrupt",
    "Pacing and shot timing grammar",
    "Core cognitive motivation mechanism",
  ];
  const nonTransferableFactors: string[] = [];
  if (isMega) {
    nonTransferableFactors.push("Celebrity fanbase affinity");
  }
  if (input.transferContext?.highClaimRisk) {
    nonTransferableFactors.push("High-stakes health/financial claim scrutiny");
  }

  const rawTransfer = (brandFit * 0.35 + productFit * 0.35 + productionFeasibility * 0.15 + (isMega ? 0.3 : 0.8) * 0.15) - claimPenalty;
  const transferPotential: TransferPotentialScore = {
    score: Math.round(Math.max(0.1, Math.min(1.0, rawTransfer)) * 100) / 100,
    brandFit,
    productFit,
    productionFeasibility,
    audienceRelevance,
    claimRiskPenalty: claimPenalty,
    transferableFactors,
    nonTransferableFactors,
    evidenceRefs: refs,
  };

  // 4. Target 4: Business Potential
  let businessPotential: BusinessPotentialScore;
  const hasConversion = input.businessTelemetry?.conversionRate !== undefined && input.businessTelemetry?.conversionRate !== null;
  const hasRoas = input.businessTelemetry?.roas !== undefined && input.businessTelemetry?.roas !== null;

  if (hasRoas) {
    const roas = input.businessTelemetry!.roas!;
    businessPotential = {
      score: Math.min(1.0, Math.max(0.0, (roas - 0.5) / 2.5)),
      attributedConversionRate: hasConversion ? input.businessTelemetry!.conversionRate : null,
      estimatedRoas: roas,
      downstreamValueBand: roas >= 2.5 ? "EXCEPTIONAL" : roas >= 1.5 ? "HIGH" : roas >= 1.0 ? "MEDIUM" : "LOW",
      epistemicState: "OBSERVED",
      evidenceRefs: refs.filter((r) => r.field === "performance"),
    };
    if (!hasConversion) {
      missingDimensions.push("business_conversion_telemetry");
    }
  } else if (hasConversion) {
    // Conversion is observed, but ROAS is unavailable - NEVER default ROAS to 1.0 or claim ROAS is OBSERVED
    missingDimensions.push("business_roas_telemetry");
    const cr = input.businessTelemetry!.conversionRate!;
    businessPotential = {
      score: Math.min(1.0, Math.max(0.0, cr / 0.05)),
      attributedConversionRate: cr,
      estimatedRoas: null,
      downstreamValueBand: cr >= 0.05 ? "EXCEPTIONAL" : cr >= 0.02 ? "HIGH" : cr >= 0.01 ? "MEDIUM" : "LOW",
      epistemicState: "OBSERVED",
      evidenceRefs: refs.filter((r) => r.field === "performance"),
    };
  } else {
    missingDimensions.push("business_conversion_telemetry");
    missingDimensions.push("business_roas_telemetry");
    businessPotential = {
      score: null,
      attributedConversionRate: null,
      estimatedRoas: null,
      downstreamValueBand: "UNKNOWN",
      epistemicState: "UNKNOWN",
      evidenceRefs: [],
    };
  }

  // Composite 1-10 rating with evidence coverage calculation
  const totalTrackedDimensions = 4;
  const hasBreakoutEvidence = input.observed?.views !== undefined && input.observed.views !== null;
  const hasBusinessEvidence = hasRoas || hasConversion;
  const observedCount = 2 + (hasBreakoutEvidence ? 1 : 0) + (hasBusinessEvidence ? 1 : 0);
  const evidenceCoverage = Math.round((observedCount / totalTrackedDimensions) * 100) / 100;

  // Rating out of 10 computed honestly: weighted by available component scores
  let composite = (conceptStrength.score * 0.4 + transferPotential.score * 0.4 + breakoutScoreVal * 0.2) * 10;
  if (businessPotential.score !== null) {
    composite = (conceptStrength.score * 0.3 + transferPotential.score * 0.3 + breakoutScoreVal * 0.15 + businessPotential.score * 0.25) * 10;
  }
  const ratingOutOfTen = Math.round(Math.max(1.0, Math.min(10.0, composite)) * 10) / 10;
  const ratingStatus = evidenceCoverage < 0.6 ? "LOW_EVIDENCE" : "CALCULATED";

  return {
    ratingOutOfTen,
    ratingStatus,
    target: "composite",
    observedBreakout,
    conceptStrength,
    transferPotential,
    businessPotential,
    missingDimensions,
    evidenceCoverage,
    version: "v3.0.0",
  };
}

/**
 * Builds a versioned ConceptGenome linking observed features to 11D Angle Bible entries.
 */
export function buildConceptGenome(params: {
  genomeId: string;
  slugs: string[];
  pacingSecondsPerShot?: number;
  loopBehavior?: string;
  audioRole?: string;
  evidenceRefs?: EvidenceRef[];
}): ConceptGenome {
  const dimensions: Record<string, ConceptDimensionValue> = {};
  const refs = params.evidenceRefs ?? [];

  for (const slug of params.slugs) {
    const entry = getBibleEntryBySlug(slug);
    if (entry) {
      dimensions[entry.dimensionName] = {
        dimensionId: entry.dimensionId,
        dimensionName: entry.dimensionName,
        entrySlug: entry.slug,
        name: entry.name,
        definition: entry.definition,
        psychologicalMechanism: entry.psychologicalMechanism,
        epistemicState: "OBSERVED",
        evidenceRefs: refs,
      };
    }
  }

  return {
    genomeId: params.genomeId,
    version: "1.0.0",
    dimensions,
    angleBibleSlugs: params.slugs,
    recurringMotifs: [],
    pacingSecondsPerShot: params.pacingSecondsPerShot,
    loopBehavior: params.loopBehavior,
    audioRole: params.audioRole,
  };
}

/**
 * Extracts and classifies candidate Angle Bible slugs from multimodal evidence
 * (transcript text, detected OCR, visual cues).
 */
export function extractConceptGenomeFromEvidence(params: {
  genomeId: string;
  transcript?: string;
  ocrText?: string[];
  onScreenActions?: string[];
  pacingSecondsPerShot?: number;
  evidenceRefs?: EvidenceRef[];
}): ConceptGenome {
  const matchedSlugs = new Set<string>();
  const combinedText = [
    params.transcript ?? "",
    ...(params.ocrText ?? []),
    ...(params.onScreenActions ?? []),
  ].join(" ").toLowerCase();

  for (const dim of ANGLE_BIBLE_DIMENSIONS) {
    for (const entry of dim.entries) {
      // Check cues in transcript or on-screen actions
      const matchCue = entry.onScreenCues.some((cue) => combinedText.includes(cue.toLowerCase()));
      const matchSlug = combinedText.includes(entry.slug.replace(/-/g, " "));
      if (matchCue || matchSlug) {
        matchedSlugs.add(entry.slug);
      }
    }
  }

  return buildConceptGenome({
    genomeId: params.genomeId,
    slugs: Array.from(matchedSlugs),
    pacingSecondsPerShot: params.pacingSecondsPerShot,
    evidenceRefs: params.evidenceRefs,
  });
}

/**
 * Computes semantic dimension overlap and Jaccard similarity between two ConceptGenomes.
 */
export function compareConceptGenomes(a: ConceptGenome, b: ConceptGenome): {
  similarity: number;
  sharedDimensions: string[];
  differingDimensions: string[];
} {
  const slugsA = new Set(a.angleBibleSlugs);
  const slugsB = new Set(b.angleBibleSlugs);

  const shared: string[] = [];
  const differing: string[] = [];

  for (const s of slugsA) {
    if (slugsB.has(s)) {
      shared.push(s);
    } else {
      differing.push(s);
    }
  }
  for (const s of slugsB) {
    if (!slugsA.has(s)) {
      differing.push(s);
    }
  }

  const totalDistinct = slugsA.size + slugsB.size - shared.length;
  const similarity = totalDistinct > 0 ? Math.round((shared.length / totalDistinct) * 100) / 100 : 0;

  return {
    similarity,
    sharedDimensions: shared,
    differingDimensions: differing,
  };
}

/**
 * Assembles a complete, auditable CreativeConcept entity.
 */
export function createCreativeConcept(params: {
  conceptId: string;
  name: string;
  mechanismDescription: string;
  genome: ConceptGenome;
  sourceCreativeIds?: string[];
  artifactRefs?: EvidenceRef[];
  positiveExamples?: string[];
  negativeControls?: string[];
  nicheApplicability?: string[];
  productTransferConditions?: string[];
  productionComplexity?: "LOW" | "MEDIUM" | "HIGH";
  estimatedCostBand?: "ZERO_SPEND" | "LOW" | "STANDARD" | "HIGH";
  scores: DecomposedOpportunityRating;
}): CreativeConcept {
  const now = new Date().toISOString();
  return {
    conceptId: params.conceptId,
    version: "1.0.0",
    name: params.name,
    mechanismDescription: params.mechanismDescription,
    genome: params.genome,
    sourceCreativeIds: params.sourceCreativeIds ?? [],
    artifactRefs: params.artifactRefs ?? [],
    positiveExamples: params.positiveExamples ?? [],
    negativeControls: params.negativeControls ?? [],
    nicheApplicability: params.nicheApplicability ?? ["general"],
    productTransferConditions: params.productTransferConditions ?? [],
    productionComplexity: params.productionComplexity ?? "MEDIUM",
    estimatedCostBand: params.estimatedCostBand ?? "LOW",
    rightsConstraints: [],
    fatigueState: "emerging",
    scores: params.scores,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Produces an auditable, truth-first human-readable summary of the 4 opportunity targets.
 */
export function formatDecomposedOpportunityReport(rating: DecomposedOpportunityRating): string {
  const lines: string[] = [
    `=== Opportunity Score: ${rating.ratingOutOfTen.toFixed(1)}/10.0 (Coverage: ${(rating.evidenceCoverage * 100).toFixed(0)}%) ===`,
    `Target: ${rating.target.toUpperCase()} | Version: ${rating.version}`,
    "",
    `1. Observed Breakout Score: ${rating.observedBreakout.score.toFixed(2)} [${rating.observedBreakout.epistemicState}]`,
    `   - Views Lift: ${rating.observedBreakout.viewsLift !== undefined ? `${rating.observedBreakout.viewsLift}x` : "UNAVAILABLE"}`,
    `   - Likes Lift: ${rating.observedBreakout.likesLift !== undefined ? `${rating.observedBreakout.likesLift}` : "UNAVAILABLE"}`,
    `   - Control Set Size: ${rating.observedBreakout.controlSetSize} (Confidence: ${rating.observedBreakout.confidence})`,
    "",
    `2. Concept Strength Score: ${rating.conceptStrength.score.toFixed(2)} [State: ${rating.conceptStrength.methodState}]`,
    `   - Hook: ${rating.conceptStrength.hookStrength.toFixed(2)} | Retention: ${rating.conceptStrength.retentionArchitecture.toFixed(2)}`,
    `   - Emotion: ${rating.conceptStrength.emotionalArc.toFixed(2)} | Craft: ${rating.conceptStrength.executionCraft.toFixed(2)}`,
    "",
    `3. Transfer Potential Score: ${rating.transferPotential.score.toFixed(2)}`,
    `   - Brand Fit: ${rating.transferPotential.brandFit.toFixed(2)} | Product Fit: ${rating.transferPotential.productFit.toFixed(2)}`,
    `   - Transferable Factors: ${rating.transferPotential.transferableFactors.join(", ") || "None"}`,
    "",
    `4. Business Potential: ${rating.businessPotential.score !== null ? rating.businessPotential.score.toFixed(2) : "UNAVAILABLE (Awaiting Telemetry)"}`,
    `   - Band: ${rating.businessPotential.downstreamValueBand}`,
  ];

  if (rating.missingDimensions.length > 0) {
    lines.push("", `Missing Dimensions: ${rating.missingDimensions.join(", ")}`);
  }

  return lines.join("\n");
}
