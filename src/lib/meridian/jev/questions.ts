import type { DecisionQuestion, Evaluation, EvidenceRef } from "./engine.ts";

export type ClaimSafetyInput = {
  prohibitedHits: string[];
  unsupportedClaimHits: string[];
  missingDisclaimers: string[];
};

export type TextQaInput = ClaimSafetyInput & {
  avoidedWordHits: string[];
  productRequired: boolean;
  productMentioned: boolean;
  hasHook: boolean;
  hasCta: boolean;
  toneConflict: boolean;
};

export type VisionQaInput = {
  available: boolean;
  logoPresent: boolean | null;
  logoMatchProbability: number | null;
  paletteMatch: number | null;
  productMatch: boolean | null;
  claimDetected: string | null;
  claimSupported: boolean | null;
  toneFit: number | null;
};

export type BriefGateInput = {
  hasAudience: boolean;
  hasProduct: boolean;
  hasHook: boolean;
  hasAngle: boolean;
  hasCta: boolean;
  hasFormat: boolean;
};

export type CompetitiveStrengthInput = {
  competitorCount: number;
  matchingCompetitors: number;
  ownCount: number;
  matchingOwn: number;
};

export type BrandFitQuestionInput = {
  keywordHits: number;
  keywordTotal: number;
  formatPreferred: boolean;
  brainFilled: number;
};

export type HistoricalSupportInput = {
  /** Signed lift. Null means the sample policy was not met. */
  lift: number | null;
  sampleSize: number;
  impressions: number;
  metric: string;
};

export type RiskSafetyInput = {
  claimIntensity: number;
  aggressiveRejections: number;
  negativeLift: number;
};

export type PositioningFitInput = {
  overlap: number;
  avoidedWordHits: string[];
  brainHasPositioning: boolean;
};

export type ReproducibilityInput = {
  templateCoverage: number;
  copiesProtectedPhrasing: boolean;
};

/** Structured evidence for one opportunity. The gate computes probability. Callers cannot pass one in. */
export type OpportunityGateInput = {
  competitive: CompetitiveStrengthInput;
  brand: BrandFitQuestionInput;
  historical: HistoricalSupportInput;
  risk: RiskSafetyInput;
  reproducibility: ReproducibilityInput;
};

const QA_THRESHOLDS = { autoApprove: 0.9, humanReview: 0.6, minConfidenceForAuto: 0.75 };
export const OPPORTUNITY_THRESHOLDS = { autoApprove: 0.88, humanReview: 0.28, minConfidenceForAuto: 0.72 };

function evidence(id: string, source: string, summary: string): EvidenceRef[] {
  return [{ id, source, summary }];
}

function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export const claimSafety: DecisionQuestion<ClaimSafetyInput> = {
  id: "claim_safety",
  version: "v1",
  description: "Whether the text stays inside allowed claims and required disclosures.",
  thresholds: QA_THRESHOLDS,
  evaluate(input): Evaluation {
    if (input.prohibitedHits.length > 0) {
      const summary = `Prohibited language: ${input.prohibitedHits.join(", ")}`;
      return {
        probability: 0.04,
        confidence: 0.97,
        reasons: [summary],
        evidence: evidence("prohibited", "brand_rules", summary),
      };
    }
    if (input.unsupportedClaimHits.length > 0) {
      const summary = `Unsupported claim language: ${input.unsupportedClaimHits.join(", ")}`;
      return {
        probability: 0.22,
        confidence: 0.9,
        reasons: [summary],
        evidence: evidence("unsupported", "claim_rules", summary),
      };
    }
    if (input.missingDisclaimers.length > 0) {
      const summary = `Missing required disclaimer: ${input.missingDisclaimers.join(", ")}`;
      return {
        probability: 0.72,
        confidence: 0.88,
        reasons: [summary],
        evidence: evidence("disclaimer", "brand_rules", summary),
      };
    }
    return {
      probability: 0.96,
      confidence: 0.9,
      reasons: ["No prohibited or unsupported claim, and no missing disclaimer."],
      evidence: evidence("claims", "brand_rules", "Claim check found no violation."),
    };
  },
};

export const creativeQa: DecisionQuestion<TextQaInput> = {
  id: "creative_qa",
  version: "v1",
  description: "Text creative QA from structured guardian evidence. Does not inspect pixels.",
  thresholds: QA_THRESHOLDS,
  evaluate(input): Evaluation {
    const claim = claimSafety.evaluate(input);
    if (input.prohibitedHits.length > 0 || input.unsupportedClaimHits.length > 0) {
      return claim;
    }
    if (input.productRequired && !input.productMentioned) {
      const summary = "The named product is not present in the creative.";
      return {
        probability: 0.3,
        confidence: 0.9,
        reasons: [summary],
        evidence: evidence("product", "product_record", summary),
      };
    }
    let probability = input.missingDisclaimers.length > 0 ? 0.72 : 0.93;
    const reasons: string[] = [];
    const refs = [...claim.evidence];
    if (input.missingDisclaimers.length > 0) {
      reasons.push(`Missing required disclaimer: ${input.missingDisclaimers.join(", ")}`);
    }
    if (input.toneConflict || input.avoidedWordHits.length > 0) {
      probability = Math.min(probability, 0.7);
      const summary = input.avoidedWordHits.length
        ? `Tone conflict. Avoided words: ${input.avoidedWordHits.join(", ")}`
        : "Tone conflicts with the brand voice.";
      reasons.push(summary);
      refs.push({ id: "tone", source: "brand_voice", summary });
    }
    if (!input.hasHook) {
      probability = Math.min(probability, 0.66);
      reasons.push("No hook is specified.");
    }
    if (!input.hasCta) {
      probability = Math.min(probability, 0.68);
      reasons.push("No call to action is specified.");
    }
    if (reasons.length === 0) {
      reasons.push("Product is present, claims are allowed, and the hook and call to action are specified.");
    }
    return { probability, confidence: 0.88, reasons, evidence: refs };
  },
};

export const visualQa: DecisionQuestion<VisionQaInput> = {
  id: "visual_qa",
  version: "v1",
  description: "Visual QA from vision-model evidence. Refuses to score an image it was not given.",
  thresholds: { autoApprove: 0.9, humanReview: 0.4, minConfidenceForAuto: 0.8 },
  evaluate(input): Evaluation {
    if (!input.available) {
      const summary = "No vision evidence. Visual QA was not run, so this cannot be auto-approved.";
      return {
        probability: 0.5,
        confidence: 0.15,
        reasons: [summary],
        evidence: evidence("vision_absent", "vision", summary),
      };
    }
    if (input.claimSupported === false) {
      const summary = `Vision evidence found an unsupported claim${input.claimDetected ? `: ${input.claimDetected}` : ""}.`;
      return {
        probability: 0.16,
        confidence: 0.86,
        reasons: [summary],
        evidence: evidence("vision_claim", "vision", summary),
      };
    }
    if (input.logoPresent === false || (input.logoMatchProbability !== null && input.logoMatchProbability < 0.5)) {
      const summary = "Logo evidence does not match the brand.";
      return {
        probability: 0.18,
        confidence: 0.84,
        reasons: [summary],
        evidence: evidence("logo", "vision", summary),
      };
    }
    if (input.productMatch === false) {
      const summary = "Vision evidence says the product is not the one specified.";
      return {
        probability: 0.2,
        confidence: 0.84,
        reasons: [summary],
        evidence: evidence("product", "vision", summary),
      };
    }
    const parts = [input.logoMatchProbability, input.paletteMatch, input.toneFit].filter(
      (part): part is number => typeof part === "number",
    );
    const probability = parts.length === 0 ? 0.7 : parts.reduce((sum, part) => sum + part, 0) / parts.length;
    return {
      probability,
      confidence: 0.82,
      reasons: ["Vision evidence was present and no hard visual failure was flagged."],
      evidence: evidence("vision", "vision", "Structured visual evidence was evaluated. The image itself was not passed to the gate."),
    };
  },
};

export const briefGate: DecisionQuestion<BriefGateInput> = {
  id: "brief_gate",
  version: "v1",
  description: "Whether a brief has the elements production is allowed to use.",
  thresholds: QA_THRESHOLDS,
  evaluate(input): Evaluation {
    const checks: [string, boolean][] = [
      ["audience", input.hasAudience],
      ["product", input.hasProduct],
      ["hook", input.hasHook],
      ["angle", input.hasAngle],
      ["call to action", input.hasCta],
      ["format", input.hasFormat],
    ];
    const missing = checks.filter(([, ok]) => !ok).map(([label]) => label);
    const filled = checks.length - missing.length;
    if (missing.length === 0) {
      return {
        probability: 0.95,
        confidence: 0.95,
        reasons: ["Audience, product, hook, angle, call to action, and format are specified."],
        evidence: evidence("brief", "brief", "All required brief elements are present."),
      };
    }
    const summary = `Brief is missing: ${missing.join(", ")}.`;
    const probability = filled >= 4 ? 0.74 : 0.34;
    return {
      probability,
      confidence: 0.93,
      reasons: [summary],
      evidence: evidence("brief", "brief", summary),
    };
  },
};

export const competitiveStrength: DecisionQuestion<CompetitiveStrengthInput> = {
  id: "competitive_strength",
  version: "v1",
  description: "Whether stored competitor creatives show an opening this brand has not already used.",
  thresholds: OPPORTUNITY_THRESHOLDS,
  evaluate(input): Evaluation {
    if (input.competitorCount <= 0) {
      const summary = "No competitor observations. Competitive strength is not estimated.";
      return { probability: 0.3, confidence: 0.2, reasons: [summary], evidence: evidence("competitive_strength", "market", summary) };
    }
    const usage = input.matchingCompetitors / input.competitorCount;
    const ownUsage = input.ownCount <= 0 ? 0 : input.matchingOwn / input.ownCount;
    const opening = unit(usage - ownUsage);
    const confidence = unit(0.5 + 0.06 * Math.min(input.competitorCount, 6));
    if (input.competitorCount >= 3 && usage >= 0.85) {
      const summary = `Saturated in the stored set: ${input.matchingCompetitors} of ${input.competitorCount} competitor creatives use this angle.`;
      return { probability: 0.27, confidence, reasons: [summary], evidence: evidence("competitive_strength", "market", summary) };
    }
    const seen = input.matchingCompetitors > 0 ? 1 : 0;
    const probability = unit(0.34 + 0.5 * opening + 0.16 * seen * (1 - ownUsage));
    const summary = `${input.matchingCompetitors} of ${input.competitorCount} competitor creatives use this angle. This brand uses it in ${input.matchingOwn} of ${input.ownCount} of its own.`;
    return { probability, confidence, reasons: [summary], evidence: evidence("competitive_strength", "market", summary) };
  },
};

export const brandFitQuestion: DecisionQuestion<BrandFitQuestionInput> = {
  id: "brand_fit",
  version: "v1",
  description: "Lexical fit between a candidate and the written brand brain. Not a model grade.",
  thresholds: OPPORTUNITY_THRESHOLDS,
  evaluate(input): Evaluation {
    if (input.brainFilled < 0.15 || input.keywordTotal <= 0) {
      const summary = "The brand brain is too thin to confirm fit.";
      return { probability: 0.18, confidence: 0.28, reasons: [summary], evidence: evidence("brand_fit", "brand_brain", summary) };
    }
    const overlap = input.keywordHits / input.keywordTotal;
    const probability = unit(overlap * 0.85 + (input.formatPreferred ? 0.15 : 0));
    const confidence = unit(0.45 + input.brainFilled * 0.45);
    const summary = `Keyword overlap ${input.keywordHits}/${input.keywordTotal}${input.formatPreferred ? ", and the format is listed as preferred" : ""}.`;
    return { probability, confidence, reasons: [summary], evidence: evidence("brand_fit", "brand_brain", summary) };
  },
};

export const historicalSupport: DecisionQuestion<HistoricalSupportInput> = {
  id: "historical_support",
  version: "v1",
  description: "Whether stored performance for this attribute clears the learning policy.",
  thresholds: OPPORTUNITY_THRESHOLDS,
  evaluate(input): Evaluation {
    if (input.lift === null || input.sampleSize < 3) {
      const summary = "No learned pattern meets the sample policy for this angle or hook.";
      return { probability: 0.4, confidence: 0.22, reasons: [summary], evidence: evidence("historical_support", "performance", summary) };
    }
    const confidence = unit(0.58 + Math.min(input.sampleSize, 8) * 0.04);
    if (input.lift >= 0) {
      const probability = unit(0.62 + Math.min(input.lift, 1) * 0.33);
      const summary = `${input.metric.toUpperCase()} lift ${(input.lift * 100).toFixed(0)}% across ${input.sampleSize} creatives and ${input.impressions} impressions.`;
      return { probability, confidence, reasons: [summary], evidence: evidence("historical_support", "learned_pattern", summary) };
    }
    const probability = unit(0.5 + input.lift * 0.6);
    const summary = `${input.metric.toUpperCase()} lift ${(input.lift * 100).toFixed(0)}% is below this brand's baseline.`;
    return { probability, confidence, reasons: [summary], evidence: evidence("historical_support", "learned_pattern", summary) };
  },
};

export const riskSafety: DecisionQuestion<RiskSafetyInput> = {
  id: "risk_safety",
  version: "v1",
  description: "Whether claim intensity, past rejections, and negative lift make the candidate unsafe to pursue.",
  thresholds: OPPORTUNITY_THRESHOLDS,
  evaluate(input): Evaluation {
    let danger = unit(input.claimIntensity);
    const notes: string[] = [`Claim intensity ${input.claimIntensity.toFixed(2)}. `];
    if (input.aggressiveRejections >= 2 && input.claimIntensity >= 0.45) {
      danger = unit(danger + 0.28);
      notes.push(`The brand rejected aggressive or unsupported claims ${input.aggressiveRejections} times.`);
    }
    if (input.negativeLift > 0) {
      danger = unit(danger + Math.min(0.45, input.negativeLift));
      notes.push(`Negative performance lift of ${(input.negativeLift * 100).toFixed(0)}% adds risk.`);
    }
    const summary = notes.join(" ").trim();
    return {
      probability: unit(1 - danger),
      confidence: 0.84,
      reasons: [summary],
      evidence: evidence("risk_safety", "reviews", summary),
    };
  },
};

export const positioningFit: DecisionQuestion<PositioningFitInput> = {
  id: "positioning_fit",
  version: "v1",
  description: "Lexical fit between a creative and the written positioning. Not a model grade.",
  thresholds: QA_THRESHOLDS,
  evaluate(input): Evaluation {
    let probability = input.overlap;
    const reasons: string[] = [];
    if (input.avoidedWordHits.length > 0) {
      probability = Math.min(probability, 0.58);
      reasons.push(`Avoided words present: ${input.avoidedWordHits.join(", ")}`);
    }
    if (!input.brainHasPositioning) {
      reasons.push("Positioning is blank, so fit cannot be confirmed.");
    } else if (reasons.length === 0) {
      reasons.push(`Token overlap with positioning is ${probability.toFixed(2)}.`);
    }
    return {
      probability,
      confidence: input.brainHasPositioning ? 0.8 : 0.3,
      reasons,
      evidence: evidence("positioning", "brand_brain", reasons[0] ?? "Positioning fit."),
    };
  },
};

export const reproducibility: DecisionQuestion<ReproducibilityInput> = {
  id: "reproducibility",
  version: "v1",
  description: "Whether a concept can be reproduced from a workflow without copying protected phrasing.",
  thresholds: QA_THRESHOLDS,
  evaluate(input): Evaluation {
    if (input.copiesProtectedPhrasing) {
      const summary = "The concept repeats protected phrasing and cannot be reproduced as-is.";
      return {
        probability: 0.08,
        confidence: 0.9,
        reasons: [summary],
        evidence: evidence("ip", "workflow", summary),
      };
    }
    const probability = input.templateCoverage >= 0.8 ? 0.93 : input.templateCoverage >= 0.5 ? 0.7 : 0.36;
    return {
      probability,
      confidence: 0.85,
      reasons: [`Workflow coverage is ${input.templateCoverage.toFixed(2)}. Coverage means a template and a product exist, not that every line is written.`],
      evidence: evidence("reproducibility", "workflow", "A workflow template can be filled without copying a competitor line."),
    };
  },
};

const GATE_WEIGHTS = {
  brand: 0.26,
  historical: 0.24,
  competitive: 0.18,
  reproducibility: 0.14,
  safety: 0.18,
} as const;

/**
 * Combines component questions. It does not accept a rank score.
 * Unsafe risk or protected phrasing caps the result under the reject line.
 */
export const opportunityGate: DecisionQuestion<OpportunityGateInput> = {
  id: "opportunity_gate",
  version: "v2",
  description: "Whether structured market, brand, history, risk, and reproducibility evidence supports pursuing a candidate.",
  thresholds: OPPORTUNITY_THRESHOLDS,
  evaluate(input): Evaluation {
    const brand = brandFitQuestion.evaluate(input.brand);
    const historical = historicalSupport.evaluate(input.historical);
    const competitive = competitiveStrength.evaluate(input.competitive);
    const repro = reproducibility.evaluate(input.reproducibility);
    const safety = riskSafety.evaluate(input.risk);
    const parts = [
      { weight: GATE_WEIGHTS.brand, evaluation: brand },
      { weight: GATE_WEIGHTS.historical, evaluation: historical },
      { weight: GATE_WEIGHTS.competitive, evaluation: competitive },
      { weight: GATE_WEIGHTS.reproducibility, evaluation: repro },
      { weight: GATE_WEIGHTS.safety, evaluation: safety },
    ];
    let probability = parts.reduce((sum, part) => sum + part.weight * part.evaluation.probability, 0);
    const confidence = parts.reduce((sum, part) => sum + part.weight * part.evaluation.confidence, 0);
    const reasons = parts.map((part) => part.evaluation.reasons[0] ?? "").filter(Boolean);
    if (input.reproducibility.copiesProtectedPhrasing || repro.probability < 0.15) {
      probability = Math.min(probability, 0.12);
      reasons.unshift("Protected phrasing blocks this candidate.");
    } else if (safety.probability < 0.22) {
      probability = Math.min(probability, 0.2);
      reasons.unshift("Risk evidence caps this candidate below the reject line.");
    }
    const refs = parts.flatMap((part) => part.evaluation.evidence);
    return { probability, confidence, reasons, evidence: refs };
  },
};

export const QUESTIONS = [
  claimSafety,
  creativeQa,
  visualQa,
  briefGate,
  competitiveStrength,
  brandFitQuestion,
  historicalSupport,
  riskSafety,
  opportunityGate,
  positioningFit,
  reproducibility,
] as const;
