import { z } from "zod";

export const CREATIVE_JUDGMENT_SCHEMA_V1 = "creative-judgment.v1";

export const creativeFormatRecommendationSchema = z.object({
  format: z.enum(["image", "video", "carousel"]),
  rationale: z.string().min(1, "Rationale must not be empty"),
  priority: z.number().int().min(1),
});

export const formatSuitabilityItemSchema = z.object({
  suitable: z.boolean(),
  rationale: z.string().min(1, "Suitability rationale must not be empty"),
});

/**
 * Strict schema for Creative Judgment JEV responses.
 * Enforces explicit mechanism, recommended format priority array, and suitability map.
 */
export const creativeJudgmentResponseSchemaV1 = z.object({
  decision: z.enum([
    "APPROVE",
    "AUTO_APPROVE",
    "HUMAN_REVIEW",
    "REJECT",
    "admissible",
    "abstain_insufficient_evidence",
    "abstain_rejected",
    "abstain_malformed",
  ]),
  creativeMechanism: z.string().min(1, "Creative mechanism is required"),
  recommendedFormats: z.array(creativeFormatRecommendationSchema).min(1, "At least one format recommendation is required"),
  formatSuitability: z.record(z.string(), formatSuitabilityItemSchema),
  conceptStrengthScore: z.number().min(0).max(1).optional(),
  brandFitScore: z.number().min(0).max(1).optional(),
  transferabilityScore: z.number().min(0).max(1).optional(),
  isOutlier: z.boolean().optional(),
  distributionSuitability: z.enum(["paid_only", "organic_only", "both"]).optional(),
  evidenceRefs: z.array(z.string()).default([]),
  reasons: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type CreativeJudgmentResponseV1 = z.infer<typeof creativeJudgmentResponseSchemaV1>;
