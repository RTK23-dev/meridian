/**
 * Unified JEV Question Registry
 *
 * Central versioned question catalog aggregating organic, creator, brand,
 * safety, and production questions.
 */

import type { JevQuestionSpec } from "./types.ts";
import { ORGANIC_QUESTIONS } from "./questions/organic.ts";
import { CREATOR_QUESTIONS } from "./questions/creator.ts";
import { BRAND_QUESTIONS } from "./questions/brand.ts";
import { SAFETY_QUESTIONS } from "./questions/safety.ts";
import { PRODUCTION_QUESTIONS } from "./questions/production.ts";
import { CREATIVE_QUESTIONS } from "./questions/creative.ts";
import { QUESTIONS } from "./questions.ts";

export type QuestionRecord = {
  id: string;
  version: string;
  purpose: string;
  thresholds: { autoApprove: number; humanReview: number; minConfidenceForAuto: number };
  status: "active";
};

export function questionRegistry(): QuestionRecord[] {
  return QUESTIONS.map((question) => ({
    id: question.id,
    version: question.version,
    purpose: question.description,
    thresholds: { ...question.thresholds },
    status: "active" as const,
  }));
}

export const UNIFIED_QUESTION_REGISTRY: Record<string, JevQuestionSpec> = {
  ...ORGANIC_QUESTIONS,
  ...CREATOR_QUESTIONS,
  ...BRAND_QUESTIONS,
  ...SAFETY_QUESTIONS,
  ...PRODUCTION_QUESTIONS,
  ...CREATIVE_QUESTIONS,
};

export function getQuestionById(id: string): JevQuestionSpec | undefined {
  return UNIFIED_QUESTION_REGISTRY[id];
}

export function listQuestionsByCategory(category: "organic" | "creator" | "brand" | "safety" | "production"): JevQuestionSpec[] {
  switch (category) {
    case "organic":
      return Object.values(ORGANIC_QUESTIONS);
    case "creator":
      return Object.values(CREATOR_QUESTIONS);
    case "brand":
      return Object.values(BRAND_QUESTIONS);
    case "safety":
      return Object.values(SAFETY_QUESTIONS);
    case "production":
      return Object.values(PRODUCTION_QUESTIONS);
  }
}

export function getRequiredEvidenceForQuestions(questionIds: string[]): string[] {
  const requirements = new Set<string>();
  for (const qId of questionIds) {
    const q = getQuestionById(qId);
    if (q) {
      for (const req of q.evidenceRequirements) {
        requirements.add(req);
      }
    }
  }
  return [...requirements];
}

export const jevRegistry = {
  get: getQuestionById,
  list: () => Object.values(UNIFIED_QUESTION_REGISTRY),
  getByCategory: listQuestionsByCategory,
  getRequiredEvidence: getRequiredEvidenceForQuestions,
  register: (question: JevQuestionSpec) => {
    UNIFIED_QUESTION_REGISTRY[question.id] = question;
  },
};
