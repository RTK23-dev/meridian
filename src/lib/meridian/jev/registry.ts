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
