import { useId, useState } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, SelectInput, TextArea } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  REVIEW_ACTIONS,
  REVIEW_NOTE_MAX,
  checkReview,
  noteRequired,
  reasonLabel,
  reasonRequired,
  reviewActionLabel,
  reviewConfirmLabel,
  reviewDialogTitle,
  type ReviewAction,
  type ReviewPayload,
} from "./review-rules.ts";

export type ReviewTarget = { creativeId: string; title: string; action: ReviewAction };

type ReviewDialogProps = {
  /** The variant and the action chosen by the button or key. Null when closed. */
  target: ReviewTarget | null;
  /** The reason codes the server accepts. The caller passes them in; the dialog never invents one. */
  allowedCodes: readonly string[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (creativeId: string, payload: ReviewPayload) => void;
};

/**
 * Approve, reject or request a revision. Rejection needs a reason from the server's list and a note. A revision needs a
 * note. Approval may carry a note. The parent remounts the dialog for each opening (through a key), so the fields start
 * empty.
 */
export function ReviewDialog({ target, allowedCodes, pending, onClose, onSubmit }: ReviewDialogProps) {
  const [action, setAction] = useState<ReviewAction>(target?.action ?? "approve");
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const groupName = useId();
  const descriptionId = useId();

  const check = checkReview({ action, reasonCode, note }, allowedCodes);

  function submit() {
    if (!target || !check.ok || pending) return;
    onSubmit(target.creativeId, check.payload);
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      {target ? (
        <DialogContent
          aria-describedby={descriptionId}
          className="max-w-lg"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        >
          <DialogTitle className="font-display text-2xl">{reviewDialogTitle(action)}</DialogTitle>
          <DialogDescription id={descriptionId} className="mt-2 text-sm text-fg-muted">
            {target.title}. The decision, the reason and the note stay with this review.
          </DialogDescription>
          <div className="mt-4 space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Decision</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {REVIEW_ACTIONS.map((option) => (
                  <label
                    key={option}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border p-3 text-sm",
                      action === option ? "border-accent bg-accent-soft font-semibold" : "border-border bg-surface",
                    )}
                  >
                    <input
                      type="radio"
                      name={groupName}
                      value={option}
                      checked={action === option}
                      disabled={pending}
                      onChange={() => setAction(option)}
                      className="size-4"
                    />
                    {reviewActionLabel(option)}
                  </label>
                ))}
              </div>
            </fieldset>

            {reasonRequired(action) ? (
              <Field label="Reason" hint="These are the reasons the server records. Choose the one that matches the problem." required>
                <SelectInput value={reasonCode} required disabled={pending} onChange={(event) => setReasonCode(event.currentTarget.value)}>
                  <option value="">Choose a reason</option>
                  {allowedCodes.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
                </SelectInput>
              </Field>
            ) : null}

            <Field
              label={noteRequired(action) ? "Reviewer note (required)" : "Reviewer note (optional)"}
              hint={`Up to ${REVIEW_NOTE_MAX} characters.`}
              required={noteRequired(action)}
            >
              <TextArea
                rows={3}
                maxLength={REVIEW_NOTE_MAX}
                value={note}
                required={noteRequired(action)}
                disabled={pending}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </Field>

            <p role="status" aria-live="polite" className={cn("text-sm", check.ok ? "text-fg-muted" : "text-danger")}>
              {check.ok ? "Ready to send." : check.message}
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="quiet" disabled={pending} onClick={onClose}>Cancel</Button>
              <Button type="button" variant={action === "reject" ? "danger" : "primary"} disabled={!check.ok || pending} onClick={submit}>
                {pending ? "Sending…" : reviewConfirmLabel(action)}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
