/**
 * The review dialog's zod schema. It wraps checkReview, the dialog's existing rule, so the rule lives in one place. Each
 * message from checkReview is placed on the field it is about: a reason message on the reason, a note message on the note.
 */
import { z } from "zod";
import { REVIEW_ACTIONS, REVIEW_NOTE_MAX, checkReview, type ReviewAction } from "./review-rules.ts";

export const reviewFormFields = z.object({
  action: z.enum(["approve", "reject", "revision"]),
  reasonCode: z.string(),
  note: z.string(),
});

export type ReviewFormInput = z.input<typeof reviewFormFields>;

export function reviewFormSchema(allowedCodes: readonly string[]) {
  return reviewFormFields.superRefine((value, context) => {
    const check = checkReview({ action: value.action as ReviewAction, reasonCode: value.reasonCode, note: value.note }, allowedCodes);
    if (check.ok) return;
    const onReason = /reason/i.test(check.message);
    context.addIssue({ code: "custom", path: [onReason ? "reasonCode" : "note"], message: check.message });
  });
}

export { REVIEW_ACTIONS, REVIEW_NOTE_MAX };
