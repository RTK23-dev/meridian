import { z } from "zod";

export const CREATIVE_REVIEW_SCHEMA_V1 = "creative-review.v1";

export const creativeReviewResponseSchemaV1 = z.object({
  decision: z.enum(["APPROVE", "AUTO_APPROVE", "HUMAN_REVIEW", "REJECT"]),
  checks: z.object({
    claimsVerified: z.boolean(),
    originalityPassed: z.boolean(),
    rightsCleared: z.boolean(),
    craftAndSlopPassed: z.boolean(),
    aspectRatioCompliant: z.boolean().optional(),
  }),
  violations: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  notes: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type CreativeReviewResponseV1 = z.infer<typeof creativeReviewResponseSchemaV1>;
