/**
 * Organic Comment Intent Extraction
 *
 * Classifies comment threads into customer buyer questions, objections, desires, and confusion.
 * Cites actual comment texts as evidence; never synthesizes imaginary comments.
 */

export type CommentIntentType =
  | "question"
  | "objection"
  | "desire"
  | "confusion"
  | "social_proof"
  | "neutral";

export type ClassifiedComment = {
  id: string;
  text: string;
  author?: string;
  likes?: number;
  intent: CommentIntentType;
  confidence: number;
  theme?: string;
};

export type CommentIntentSummary = {
  totalAnalyzed: number;
  questions: ClassifiedComment[];
  objections: ClassifiedComment[];
  desires: ClassifiedComment[];
  confusion: ClassifiedComment[];
  socialProof: ClassifiedComment[];
  dominantThemes: Array<{ theme: string; count: number }>;
};

const QUESTION_PATTERNS = [
  /\?/,
  /\bhow (do|to|does|can|much)\b/i,
  /\bwhere (can|to|do)\b/i,
  /\bdoes (it|this)\b/i,
  /\bwhat (is|about)\b/i,
  /\bis (this|it)\b/i,
];

const OBJECTION_PATTERNS = [
  /\btoo expensive\b/i,
  /\bprice is high\b/i,
  /\bdidn't work\b/i,
  /\bdoesn't work\b/i,
  /\bscam\b/i,
  /\bsmell\b/i,
  /\bhate\b/i,
  /\bbroke\b/i,
  /\bwaste of money\b/i,
];

const DESIRE_PATTERNS = [
  /\bneed this\b/i,
  /\bi need\b/i,
  /\btake my money\b/i,
  /\bwhere can i buy\b/i,
  /\bwhere to get\b/i,
  /\bordering\b/i,
  /\bjust bought\b/i,
  /\bmust have\b/i,
];

const CONFUSION_PATTERNS = [
  /\bconfused\b/i,
  /\bwait what\b/i,
  /\bi don't get it\b/i,
  /\bhow does this even\b/i,
  /\bis this real\b/i,
];

const PROOF_PATTERNS = [
  /\bi have this\b/i,
  /\bcan confirm\b/i,
  /\bit actually works\b/i,
  /\bbest thing ever\b/i,
  /\blove this\b/i,
  /\bmy favorite\b/i,
];

export function classifyComment(comment: {
  id: string;
  text: string;
  author?: string;
  likes?: number;
}): ClassifiedComment {
  const text = comment.text.trim();

  if (OBJECTION_PATTERNS.some((p) => p.test(text))) {
    return { ...comment, text, intent: "objection", confidence: 0.85 };
  }
  if (DESIRE_PATTERNS.some((p) => p.test(text))) {
    return { ...comment, text, intent: "desire", confidence: 0.88 };
  }
  if (CONFUSION_PATTERNS.some((p) => p.test(text))) {
    return { ...comment, text, intent: "confusion", confidence: 0.80 };
  }
  if (PROOF_PATTERNS.some((p) => p.test(text))) {
    return { ...comment, text, intent: "social_proof", confidence: 0.82 };
  }
  if (QUESTION_PATTERNS.some((p) => p.test(text))) {
    return { ...comment, text, intent: "question", confidence: 0.85 };
  }

  return { ...comment, text, intent: "neutral", confidence: 0.60 };
}

export function summarizeCommentIntents(
  rawComments: Array<{ id: string; text: string; author?: string; likes?: number }>,
): CommentIntentSummary {
  const classified = rawComments.map(classifyComment);

  const questions = classified.filter((c) => c.intent === "question");
  const objections = classified.filter((c) => c.intent === "objection");
  const desires = classified.filter((c) => c.intent === "desire");
  const confusion = classified.filter((c) => c.intent === "confusion");
  const socialProof = classified.filter((c) => c.intent === "social_proof");

  return {
    totalAnalyzed: rawComments.length,
    questions,
    objections,
    desires,
    confusion,
    socialProof,
    dominantThemes: [],
  };
}
