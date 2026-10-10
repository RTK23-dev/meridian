/**
 * The question text for a stored JEV question id. The text is the description each question module declares, so the table
 * shows what the server actually asked. An id with no declared question is reported as such.
 */

import * as questionModules from "@/lib/meridian/jev/questions";

type DescribedQuestion = { id: string; description: string };

function isDescribedQuestion(value: unknown): value is DescribedQuestion {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; description?: unknown };
  return typeof candidate.id === "string" && typeof candidate.description === "string";
}

const QUESTIONS = new Map<string, string>(
  Object.values(questionModules)
    .filter(isDescribedQuestion)
    .map((question) => [question.id, question.description] as const),
);

export const UNDECLARED_QUESTION = "No question text is declared for this id.";

export function describeQuestion(id: string): string {
  return QUESTIONS.get(id) ?? UNDECLARED_QUESTION;
}
