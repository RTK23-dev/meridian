import { z } from "zod";
import { ANSWER_SCHEMA_VERSION } from "../jev/engine.ts";
import { normalizeReviewerDecision } from "../jev/reviewer-decision.ts";
import { creativeJudgmentResponseSchemaV1 } from "../jev/schemas/creative-judgment.v1.ts";
import type { CreativeJudgmentBundle } from "../creative/plan.ts";

const persistedBriefAnswerSchema = z.object({
  schemaVersion: z.literal(ANSWER_SCHEMA_VERSION),
  value: z.enum(["yes", "no", "uncertain", "insufficient", "violation"]),
  score: z.number().finite().min(0).max(1),
  probability: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1),
});

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function evidenceIds(value: unknown): string[] {
  const parsed = parseStoredJson(value);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => typeof item === "string" ? item :
      item && typeof item === "object" && "id" in item ? String(item.id) : String(item));
  }
  if (parsed && typeof parsed === "object" && "evidenceIds" in parsed && Array.isArray(parsed.evidenceIds)) {
    return parsed.evidenceIds.filter((item): item is string => typeof item === "string");
  }
  return [];
}

/**
 * Reads only persisted, schema-validated JEV outputs. Deterministic brief-completeness
 * decisions use the typed jev.answer.v1 record; they do not claim strategic formats.
 */
export function creativeJudgmentsFromStoredDecision(input: {
  id: string;
  subjectType: string;
  questionId: string;
  questionVersion: string;
  schemaVersion: string;
  decision: string;
  reviewerDecision?: string | null;
  answer: unknown;
  modelResponse: unknown;
  evidence: unknown;
  provider: string;
  model: string;
}): CreativeJudgmentBundle {
  const evidenceRefs = evidenceIds(input.evidence);
  const storedAnswer = input.subjectType === "brief" && input.questionId === "brief_completeness" &&
    input.schemaVersion === ANSWER_SCHEMA_VERSION
    ? persistedBriefAnswerSchema.safeParse(parseStoredJson(input.answer))
    : undefined;

  if (storedAnswer?.success) {
    const decision = input.decision.toUpperCase();
    const humanReviewedUncertainty = storedAnswer.data.value === "uncertain" &&
      decision === "HUMAN_REVIEW" && normalizeReviewerDecision(input.reviewerDecision) === "approved";
    const status = decision === "REJECT" || storedAnswer.data.value === "no" || storedAnswer.data.value === "violation"
      ? "abstain_rejected"
      : storedAnswer.data.value === "insufficient" || (storedAnswer.data.value === "uncertain" && !humanReviewedUncertainty)
        ? "abstain_insufficient_evidence"
        : "admissible";
    return {
      recommendedFormats: [],
      formatSuitability: {},
      status,
      evidenceRefs,
      decisionId: input.id,
      questionSetVersion: input.questionVersion || "v1",
      provider: input.provider,
      model: input.model,
    };
  }

  const response = creativeJudgmentResponseSchemaV1.safeParse(parseStoredJson(input.modelResponse));
  if (!response.success) {
    return {
      recommendedFormats: [],
      formatSuitability: {},
      status: "abstain_malformed",
      evidenceRefs,
      decisionId: input.id,
      questionSetVersion: input.questionVersion || "v1",
      provider: input.provider,
      model: input.model,
    };
  }

  const modelDecision = response.data.decision.toUpperCase();
  const status = modelDecision === "REJECT" || modelDecision === "ABSTAIN_REJECTED"
    ? "abstain_rejected"
    : modelDecision.startsWith("ABSTAIN_")
      ? modelDecision.toLowerCase() as CreativeJudgmentBundle["status"]
      : "admissible";
  return {
    conceptStrengthScore: response.data.conceptStrengthScore,
    isOutlier: response.data.isOutlier,
    creativeMechanism: response.data.creativeMechanism,
    recommendedFormats: response.data.recommendedFormats,
    formatSuitability: response.data.formatSuitability,
    brandFitScore: response.data.brandFitScore,
    transferabilityScore: response.data.transferabilityScore,
    distributionSuitability: response.data.distributionSuitability,
    status,
    evidenceRefs,
    decisionId: input.id,
    questionSetVersion: input.questionVersion || "v1",
    provider: input.provider,
    model: input.model,
  };
}
