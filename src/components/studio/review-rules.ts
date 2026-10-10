/**
 * Review rules for a studio variant. Pure: no React and no server imports, so the rules can be tested in node. The allowed
 * reason codes are passed in by the caller. They come from the server list (REVIEW_REASON_CODES), never from this file.
 */

export type ReviewAction = "approve" | "reject" | "revision";

export const REVIEW_ACTIONS: readonly ReviewAction[] = ["approve", "reject", "revision"];

/** The server keeps at most 400 characters of a reviewer note. The form stops at the same length. */
export const REVIEW_NOTE_MAX = 400;

export function reviewActionLabel(action: ReviewAction): string {
  if (action === "approve") return "Approve";
  if (action === "reject") return "Reject";
  return "Request revision";
}

export function reviewDialogTitle(action: ReviewAction): string {
  if (action === "approve") return "Approve this variant";
  if (action === "reject") return "Reject this variant";
  return "Request a revision";
}

export function reviewConfirmLabel(action: ReviewAction): string {
  if (action === "approve") return "Approve variant";
  if (action === "reject") return "Confirm rejection";
  return "Send revision request";
}

/** A rejection needs a reason from the server's list. Approval and revision take no reason. */
export function reasonRequired(action: ReviewAction): boolean {
  return action === "reject";
}

/** A rejection and a revision request both need a note. Approval may carry one. */
export function noteRequired(action: ReviewAction): boolean {
  return action === "reject" || action === "revision";
}

/** Turns a stored code such as "too_similar" into words for a select. The stored code is what the server receives. */
export function reasonLabel(code: string): string {
  const words = code.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

export type ReviewDraft = { action: ReviewAction; reasonCode: string; note: string };

export type ReviewPayload = { action: ReviewAction; reasonCode: string; note: string };

export type ReviewCheck = { ok: true; payload: ReviewPayload } | { ok: false; message: string };

/**
 * Decides whether a review can be sent, and what to send. A reviewer chooses the reason and writes the note; nothing is
 * filled in for them. The payload carries an empty reason for approval and revision, because the server reads a reason
 * only for a rejection.
 */
export function checkReview(draft: ReviewDraft, allowedCodes: readonly string[]): ReviewCheck {
  const note = draft.note.trim();
  if (reasonRequired(draft.action)) {
    if (!draft.reasonCode) return { ok: false, message: "Choose a rejection reason." };
    if (!allowedCodes.includes(draft.reasonCode)) return { ok: false, message: "Choose one of the listed reasons." };
  }
  if (noteRequired(draft.action) && !note) {
    return {
      ok: false,
      message: draft.action === "reject"
        ? "Write a note that says why this variant is rejected."
        : "Write a note that says what to change.",
    };
  }
  if (note.length > REVIEW_NOTE_MAX) {
    return { ok: false, message: `The note is ${note.length} characters. The limit is ${REVIEW_NOTE_MAX}.` };
  }
  return {
    ok: true,
    payload: {
      action: draft.action,
      reasonCode: reasonRequired(draft.action) ? draft.reasonCode : "",
      note,
    },
  };
}
