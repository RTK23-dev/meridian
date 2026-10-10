/**
 * Pure rules for the Reviews inbox: age, priority, confidence wording, the empty-queue check and the keyboard triage map.
 * No React and no server imports, so every rule here can be tested directly.
 */
import { formatDistanceToNowStrict } from "date-fns";

/** listReviews returns at most this many rows, newest first, of any status (publishing/actions.ts). */
export const REVIEW_LIST_LIMIT = 40;

/** A review younger than this is "New". */
export const NEW_UNDER_HOURS = 24;
/** A review at or older than this is "Overdue". Between the two it is "Waiting". */
export const OVERDUE_FROM_HOURS = 72;
/** A confidence below this is low, and the review is high priority. */
export const LOW_CONFIDENCE_BELOW = 0.5;
/** Confidence at or above this is high. Between the two thresholds it is the review band. */
export const HIGH_CONFIDENCE_FROM = 0.8;

/** One review row from listReviews. Only the fields the inbox reads. */
export type ReviewRow = {
  id: string;
  label: string;
  status: string;
  creativeId: string;
  decision: string;
  probability: number;
  confidence: number;
  question: string;
  reasons: readonly string[];
  answer: string;
  createdAt: string;
};

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger";

export function reviewAgeHours(createdAt: string, now: Date): number | null {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  return (now.getTime() - created) / 3_600_000;
}

/** The age badge. Its wording never depends on colour alone, so the label always says the age class. */
export function ageBadge(createdAt: string, now: Date): { label: "New" | "Waiting" | "Overdue" | "Age unknown"; tone: BadgeTone } {
  const hours = reviewAgeHours(createdAt, now);
  if (hours === null) return { label: "Age unknown", tone: "neutral" };
  if (hours >= OVERDUE_FROM_HOURS) return { label: "Overdue", tone: "warning" };
  if (hours >= NEW_UNDER_HOURS) return { label: "Waiting", tone: "info" };
  return { label: "New", tone: "neutral" };
}

/**
 * Priority is derived, not stored. A review is high priority when it is overdue, or when the engine's confidence is
 * below the low threshold. `because` says which rule applies, so the badge can be explained in the detail view.
 */
export function reviewPriority(input: { createdAt: string; confidence: number; now: Date }): { high: boolean; label: "High priority" | "Normal priority"; because: string } {
  const hours = reviewAgeHours(input.createdAt, input.now);
  const overdue = hours !== null && hours >= OVERDUE_FROM_HOURS;
  const lowConfidence = Number.isFinite(input.confidence) && input.confidence < LOW_CONFIDENCE_BELOW;
  if (overdue) return { high: true, label: "High priority", because: `Open for ${OVERDUE_FROM_HOURS} hours or more.` };
  if (lowConfidence) return { high: true, label: "High priority", because: `Confidence is below ${LOW_CONFIDENCE_BELOW.toFixed(2)}.` };
  return { high: false, label: "Normal priority", because: "Neither overdue nor low confidence." };
}

export function confidenceBadge(confidence: number): { label: "High confidence" | "Review" | "Low confidence"; tone: BadgeTone } {
  if (confidence >= HIGH_CONFIDENCE_FROM) return { label: "High confidence", tone: "success" };
  if (confidence >= LOW_CONFIDENCE_BELOW) return { label: "Review", tone: "info" };
  return { label: "Low confidence", tone: "warning" };
}

/**
 * True only when the list was not cut off and holds no open review. A full 40-row window with no open review does not
 * prove the queue is empty, because an older review could be open outside it.
 */
export function isQueueConfirmedEmpty(input: { loaded: number; open: number; limit: number }): boolean {
  return input.open === 0 && input.loaded < input.limit;
}

export type TriageAction = "next" | "previous" | "approve" | "reject";

const TRIAGE_KEYS: Record<string, TriageAction> = { j: "next", k: "previous", a: "approve", r: "reject" };

/** The triage action for a key press, or null. Approve and reject need the decide right. Typing and shortcuts are ignored. */
export function triageAction(key: string, options: { canDecide: boolean; typing: boolean; modifier: boolean }): TriageAction | null {
  if (options.typing || options.modifier) return null;
  const action = TRIAGE_KEYS[key.toLowerCase()];
  if (!action) return null;
  if ((action === "approve" || action === "reject") && !options.canDecide) return null;
  return action;
}

/** True when a key press starts in a field that takes text, so the triage keys must not act on it. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

/** Plain words for how many reviews the list holds, with the window stated when it is cut off. */
export function openCountLabel(open: number, loaded: number, limit: number): string {
  const noun = open === 1 ? "review" : "reviews";
  if (loaded >= limit) return `${open} open ${noun} in the ${limit} most recent`;
  return `${open} open ${noun}`;
}

/** The id of the reject-reason field for one review. The triage keys focus it when a reject has no reason yet. */
export function reviewReasonFieldId(reviewId: string): string {
  return `review-reason-${reviewId}`;
}

/** The id of the note field for one review. */
export function reviewNoteFieldId(reviewId: string): string {
  return `review-note-${reviewId}`;
}

/** What the reviewer has typed for one review. It is sent with the decision and never shared between reviews. */
export type ReviewDraft = { reason: string; note: string };
export const EMPTY_REVIEW_DRAFT: ReviewDraft = { reason: "", note: "" };

/** "3 days ago" for a review, or a plain line when its time cannot be read. */
export function formatOpened(createdAt: string): string {
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? "Time not recorded" : formatDistanceToNowStrict(new Date(time), { addSuffix: true });
}
