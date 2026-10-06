import {
  assertSameTenant,
  brainCorpus,
  clamp01,
  hasWord,
  type BrainSlice,
  type LearnedPattern,
  type ObservedCreative,
  type ProductFact,
  type RejectionFact,
} from "../domain.ts";
import type { OpportunityGateInput } from "../jev/questions.ts";
import { patternInfluence } from "../learning/engine.ts";
import { eligiblePatterns } from "../knowledge/scope.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import { strategyCandidates, type StrategyCandidate } from "./candidates.ts";
import type { ResearchPattern } from "../research/patterns.ts";
import { DEFAULT_WEIGHTS, opportunityScore, type ScoreWeights } from "../scoring.ts";

export type EvidenceBasis = "none" | "brand_only" | "market" | "performance" | "mixed";

export type OpportunityDraft = {
  hypothesisId: string;
  source: "prior" | "discovered";
  label: string;
  category: string;
  angle: string;
  hookType: string;
  audience: string;
  format: string;
  proofType: string;
  productId: string | null;
  productName: string;
  marketSignal: number;
  novelty: number;
  brandFit: number;
  reproducibility: number;
  risk: number;
  saturation: number;
  historicalEvidence: number;
  expectedValue: number;
  rawScore: number;
  reason: string;
  evidence: { id: string; source: string; summary: string }[];
  evidenceBasis: EvidenceBasis;
  supportingCreativeIds: string[];
  confidence: number;
  hookDirection: string;
  researchSampleCount?: number;
  researchState?: string;
  researchSourceIds?: string[];
  researchAnalysisIds?: string[];
  researchConfidence?: number;
};

export type RankedOpportunity = OpportunityDraft & {
  gateInput: OpportunityGateInput;
};

export function recommendationPosture(input: {
  source: "prior" | "discovered";
  historicalEvidence: number;
  confidence: number;
  novelty: number;
}): { posture: "exploitation" | "exploration"; because: string; uncertainty: string } {
  if (input.source === "discovered" && input.historicalEvidence > 0) {
    return {
      posture: "exploitation",
      because: "Exploitation. This direction was discovered in stored evidence and already has historical support.",
      uncertainty: `Confidence is ${input.confidence.toFixed(2)}. A learned lift is not a causal proof.`,
    };
  }
  return {
    posture: "exploration",
    because:
      input.source === "discovered"
        ? "Exploration. The direction is in the stored evidence, but there is no positive historical support yet."
        : "Exploration. This is an under-tested prior, not a validated winner.",
    uncertainty: `Confidence is ${input.confidence.toFixed(2)}. Novelty is ${input.novelty.toFixed(2)}. Missing performance stays missing.`,
  };
}

const BRAIN_KEYS: (keyof BrainSlice)[] = [
  "positioning",
  "differentiators",
  "problems",
  "desires",
  "objections",
  "tone",
  "wordsToAvoid",
  "preferredFormats",
  "prohibitedClaims",
  "requiredDisclaimers",
  "targetCustomers",
  "valueProposition",
];

function same(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function brainFilled(brain: BrainSlice): number {
  const filled = BRAIN_KEYS.filter((key) => brain[key].trim().length > 0).length;
  return filled / BRAIN_KEYS.length;
}

function relatedPatterns(patterns: LearnedPattern[], angle: string, hookType: string): LearnedPattern[] {
  const angleKey = angle.trim().toLowerCase();
  const hookKey = hookType.trim().toLowerCase();
  return patterns.filter((pattern) => {
    const value = pattern.value.trim().toLowerCase();
    if (pattern.attribute === "angle" && value === angleKey) return true;
    if (pattern.attribute === "hookType" && value === hookKey) return true;
    if (pattern.attribute.startsWith("angle+") && value.startsWith(`${angleKey}+`)) return true;
    if (pattern.attribute.includes("+") && pattern.attribute.includes("hookType") && value.includes(hookKey)) return true;
    return false;
  });
}

export function rankOpportunities(input: {
  organizationId: string;
  brandId: string;
  brain: BrainSlice;
  products: ProductFact[];
  creatives: ObservedCreative[];
  patterns: LearnedPattern[];
  rejections: RejectionFact[];
  weights?: ScoreWeights;
  /** Stored semantic clusters. Underserved clusters can become discovered opportunities. */
  clusters?: MarketCluster[];
  /** Off unless this brand explicitly opted in. Global patterns are never used. */
  useOrganizationLearning?: boolean;
  researchPatterns?: ResearchPattern[];
}): RankedOpportunity[] {
  assertSameTenant(input.creatives, input.organizationId, input.brandId);
  for (const pattern of input.patterns) {
    if (pattern.organizationId && pattern.organizationId !== input.organizationId) {
      throw new Error("Tenant scope violation.");
    }
    if (pattern.brandId && pattern.brandId !== input.brandId && pattern.scope !== "organization") {
      throw new Error("Tenant scope violation.");
    }
  }
  const patterns = eligiblePatterns(input.patterns, input.useOrganizationLearning === true);
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const competitors = input.creatives.filter((creative) => creative.origin === "competitor");
  const own = input.creatives.filter((creative) => creative.origin !== "competitor");
  const products = input.products.slice(0, 3);
  const productList = products.length > 0 ? products : [null];
  const filled = brainFilled(input.brain);
  const aggressiveRejections = input.rejections
    .filter((fact) => fact.reasonCode === "unsupported_claim" || fact.reasonCode === "prohibited_claim" || fact.reasonCode === "too_aggressive")
    .reduce((sum, fact) => sum + fact.count, 0);
  const candidates = strategyCandidates(input.creatives, patterns, {
    clusters: input.clusters,
    brandText: `${input.brain.positioning} ${input.brain.valueProposition}`,
    researchPatterns: input.researchPatterns,
  });

  const drafts: RankedOpportunity[] = [];
  for (const product of productList) {
    for (const candidate of candidates) {
      drafts.push(
        scoreOne({
          candidate,
          product,
          brain: input.brain,
          filled,
          competitors,
          own,
          patterns,
          aggressiveRejections,
          weights,
        }),
      );
    }
  }
  return diversifyByAngle(drafts.sort((a, b) => b.expectedValue - a.expectedValue || b.rawScore - a.rawScore));
}

function scoreOne(input: {
  candidate: StrategyCandidate;
  product: ProductFact | null;
  brain: BrainSlice;
  filled: number;
  competitors: ObservedCreative[];
  own: ObservedCreative[];
  patterns: LearnedPattern[];
  aggressiveRejections: number;
  weights: ScoreWeights;
}): RankedOpportunity {
  const { candidate } = input;
  const evidence: OpportunityDraft["evidence"] = [];
  const competitorHits = input.competitors.filter((creative) => same(creative.angle, candidate.angle));
  const ownHits = input.own.filter((creative) => same(creative.angle, candidate.angle));
  let marketSignal = input.competitors.length === 0 ? 0 : competitorHits.length / input.competitors.length;
  if (candidate.clusterId && (candidate.clusterCompetitorCount ?? 0) > 0) {
    const denom = Math.max(input.competitors.length, candidate.clusterCompetitorCount ?? 0, 1);
    marketSignal = (candidate.clusterCompetitorCount ?? 0) / denom;
  }
  const saturation = input.competitors.length >= 3 ? marketSignal : 0;
  const novelty = input.own.length === 0 ? 0.55 : clamp01(1 - ownHits.length / input.own.length);

  if (candidate.clusterId) {
    evidence.push({
      id: candidate.clusterId,
      source: "creative_embeddings",
      summary: `Semantic cluster ${candidate.clusterId} has ${candidate.clusterCompetitorCount ?? 0} competitor creatives and ${candidate.clusterOwnCount ?? 0} from this brand.`,
    });
  }
  if (candidate.researchPattern) {
    evidence.push({
      id: `research-pattern:${candidate.id}`,
      source: "jev_research",
      summary: `${candidate.researchPattern.summary} Pattern confidence ${candidate.researchPattern.confidence.toFixed(2)}. Representative creative records: ${candidate.researchPattern.exampleAdIds.join(", ") || "not shared"}. Research analysis records: ${(candidate.researchPattern.exampleAnalysisIds ?? []).join(", ") || "not shared"}. No outcome or causal claim is implied.`,
    });
  }
  if (candidate.source === "discovered") {
    evidence.push({
      id: "discovery",
      source: "creative_records",
      summary: candidate.clusterId
        ? "This direction came from an underserved semantic cluster, not from a preset hypothesis."
        : "This angle is not a prior. It was added because stored competitor observations or a positive learned pattern contain it.",
    });
  }

  if (input.competitors.length === 0) {
    evidence.push({
      id: "market",
      source: "market",
      summary: "No competitor observations are stored. Market signal and saturation are 0, not estimated.",
    });
  } else {
    evidence.push({
      id: "market",
      source: "market",
      summary: `${competitorHits.length} of ${input.competitors.length} stored competitor creatives use the ${candidate.angle} angle.`,
    });
    if (input.competitors.length < 3) {
      evidence.push({
        id: "saturation",
        source: "market",
        summary: "Fewer than 3 competitor observations, so saturation is not estimated.",
      });
    }
  }

  const related = relatedPatterns(input.patterns, candidate.angle, candidate.hookType);
  const positive = related.filter((pattern) => pattern.lift > 0).sort((a, b) => b.lift - a.lift)[0];
  const negative = related.filter((pattern) => pattern.lift < 0).sort((a, b) => a.lift - b.lift)[0];
  let historicalEvidence = 0;
  let risk = candidate.claimIntensity;
  if (!positive && !negative) {
    evidence.push({
      id: "history",
      source: "performance",
      summary: "No learned performance pattern for this angle or hook. Historical evidence is 0.",
    });
  }
  if (positive) {
    historicalEvidence = clamp01(positive.lift * patternInfluence(positive));
    evidence.push({
      id: "history",
      source: "learned_pattern",
      summary: `${positive.summary} Influence is ${patternInfluence(positive)} because the pattern is ${positive.state ?? "INFERRED"}.`,
    });
  }
  if (negative) {
    risk = clamp01(risk + clamp01(-negative.lift) * 0.5);
    evidence.push({
      id: "history_negative",
      source: "learned_pattern",
      summary: `${negative.summary} Negative lift raises risk and adds no historical support.`,
    });
  }

  if (input.aggressiveRejections >= 2 && candidate.claimIntensity >= 0.45) {
    risk = clamp01(risk + 0.2);
    evidence.push({
      id: "rejections",
      source: "reviews",
      summary: `This brand has rejected aggressive or unsupported claims ${input.aggressiveRejections} times. High-claim angles are penalized.`,
    });
  }

  const corpus = brainCorpus(input.brain);
  const keywordHits = candidate.keywords.filter((word) => hasWord(corpus, word)).length;
  const keywordTotal = candidate.keywords.length;
  const formatPreferred =
    hasWord(input.brain.preferredFormats, candidate.format) ||
    input.brain.preferredFormats.toLowerCase().includes(candidate.format.replaceAll("_", " "));
  const keywordScore = keywordTotal === 0 ? 0 : keywordHits / keywordTotal;
  const brandFit = corpus.trim().length < 20 ? 0.1 : clamp01(keywordScore * 0.8 + (formatPreferred ? 0.2 : 0));
  evidence.push({
    id: "brand",
    source: "brand_brain",
    summary:
      input.filled < 0.2
        ? "The brand brain is too thin to support a fit score above the floor."
        : `Brand-fit ${brandFit.toFixed(2)} is keyword overlap with the written brain, not a model opinion.`,
  });

  const reproducibility = input.product ? (candidate.source === "prior" ? 0.9 : 0.62) : 0.35;
  if (!input.product) {
    evidence.push({
      id: "product",
      source: "products",
      summary: "No product is recorded, so the concept is harder to reproduce faithfully.",
    });
  }

  const scored = opportunityScore(
    {
      brandFit,
      historicalEvidence,
      marketSignal,
      novelty,
      reproducibility,
      saturation,
      risk,
    },
    input.weights,
  );

  const hasMarket = input.competitors.length > 0 && (candidate.source === "discovered" || competitorHits.length > 0);
  const hasPerformance = Boolean(positive || negative);
  const evidenceBasis: EvidenceBasis = hasMarket && hasPerformance
    ? "mixed"
    : hasMarket
      ? "market"
      : hasPerformance
        ? "performance"
        : input.filled > 0
          ? "brand_only"
          : "none";

  const learnScore = positive ? Math.min(1, positive.sampleSize / 4) : 0;
  const confidence = clamp01(0.45 * input.filled + 0.35 * Math.min(1, input.competitors.length / 4) + 0.2 * learnScore);

  const lead =
    candidate.source === "discovered"
      ? "Discovered from stored rows, not from the prior list."
      : evidenceBasis === "none" || evidenceBasis === "brand_only"
        ? "Prior only. No competitor observations and no performance history back this angle."
        : evidenceBasis === "performance"
          ? "Prior ranked using stored performance patterns. Competitor observations of this angle are still absent."
          : evidenceBasis === "market"
            ? "Prior ranked using stored competitor observations. No performance pattern exists yet."
            : "Prior ranked using stored competitor observations and learned performance patterns.";

  const support = positive ?? negative;
  const gateInput: OpportunityGateInput = {
    competitive: {
      competitorCount: input.competitors.length,
      matchingCompetitors: competitorHits.length,
      ownCount: input.own.length,
      matchingOwn: ownHits.length,
    },
    brand: {
      keywordHits,
      keywordTotal,
      formatPreferred,
      brainFilled: input.filled,
    },
    historical: {
      lift: support ? support.lift : null,
      sampleSize: support?.sampleSize ?? 0,
      impressions: support?.impressions ?? 0,
      metric: support?.metric ?? "ctr",
    },
    risk: {
      claimIntensity: candidate.claimIntensity,
      aggressiveRejections: input.aggressiveRejections,
      negativeLift: negative ? clamp01(-negative.lift) : 0,
    },
    reproducibility: {
      templateCoverage: reproducibility,
      copiesProtectedPhrasing: competitorCopiesLine(candidate.hookLine, input.competitors),
    },
  };

  return {
    hypothesisId: candidate.id,
    source: candidate.source,
    label: candidate.label,
    category:
      candidate.source === "discovered"
        ? "discovered"
        : evidenceBasis === "market" || evidenceBasis === "mixed" || evidenceBasis === "performance"
          ? "supported"
          : "hypothesis",
    angle: candidate.angle,
    hookType: candidate.hookType,
    audience: input.brain.targetCustomers.trim(),
    format: candidate.format,
    proofType: candidate.proofType,
    productId: input.product?.id ?? null,
    productName: input.product?.name ?? "",
    marketSignal: round3(marketSignal),
    novelty: round3(novelty),
    brandFit: round3(brandFit),
    reproducibility: round3(reproducibility),
    risk: round3(risk),
    saturation: round3(saturation),
    historicalEvidence: round3(historicalEvidence),
    expectedValue: scored.normalized,
    rawScore: scored.raw,
    reason: `${lead} ${candidate.label} for ${input.product?.name || "an unspecified product"}.`,
    evidence,
    evidenceBasis,
    supportingCreativeIds: (candidate.clusterMemberIds?.length ? candidate.clusterMemberIds : competitorHits.map((creative) => creative.id)).slice(0, 8),
    confidence: round3(confidence),
    hookDirection: candidate.hookLine,
    researchSampleCount: candidate.researchPattern?.sampleCount ?? 0,
    researchState: candidate.researchPattern?.state ?? "",
    researchSourceIds: candidate.researchPattern?.exampleAdIds ?? [],
    researchAnalysisIds: candidate.researchPattern?.exampleAnalysisIds ?? [],
    researchConfidence: candidate.researchPattern?.confidence ?? 0,
    gateInput,
  };
}

function competitorCopiesLine(hookLine: string, competitors: ObservedCreative[]): boolean {
  const line = hookLine.trim().toLowerCase();
  if (line.length < 24) return false;
  return competitors.some((creative) => creative.text.toLowerCase().includes(line));
}

/** One recommendation per angle. Extra product copies of the same strategy are dropped. */
export function diversifyByAngle(drafts: RankedOpportunity[]): RankedOpportunity[] {
  const picked: RankedOpportunity[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const key = draft.angle.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(draft);
  }
  return picked;
}

export function explainOpportunity(draft: OpportunityDraft): {
  whatIsHappening: string;
  whyThisBrand: string;
  whatWorked: string;
  whatFailed: string;
  saturation: string;
  risk: string;
  whatToMake: string;
  evidence: string[];
} {
  const find = (id: string) => draft.evidence.find((item) => item.id === id)?.summary ?? "";
  return {
    whatIsHappening: find("market") || draft.reason,
    whyThisBrand: find("brand"),
    whatWorked: find("history"),
    whatFailed: find("history_negative") || find("rejections") || "No stored failure is attached to this candidate.",
    saturation: find("saturation") || `Saturation score is ${draft.saturation}.`,
    risk: `Risk score is ${draft.risk}.`,
    whatToMake: `${draft.label} in ${draft.format || "an unspecified format"} for ${draft.productName || "an unspecified product"}.`,
    evidence: draft.evidence.map((item) => item.summary),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
