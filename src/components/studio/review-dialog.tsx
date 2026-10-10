import { useId, useMemo } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, SelectInput, Textarea } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useDirtyDismiss } from "@/components/forms/use-dirty-dismiss";
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
import { reviewFormSchema, type ReviewFormInput } from "./review-form.ts";

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
  const defaults: ReviewFormInput = { action: target?.action ?? "approve", reasonCode: "", note: "" };
  const schema = useMemo(() => reviewFormSchema(allowedCodes), [allowedCodes]);
  const form = useForm<ReviewFormInput, unknown, ReviewPayload>({ resolver: zodResolver(schema), defaultValues: defaults, mode: "onChange" });
  const { register, formState: { errors, isDirty } } = form;
  const watched = form.watch();
  const action = watched.action as ReviewAction;
  const descriptionId = useId();
  const check = checkReview({ action, reasonCode: watched.reasonCode, note: watched.note }, allowedCodes);
  const dismiss = useDirtyDismiss({
    dirty: isDirty && !!target,
    onOpenChange: (open) => { if (!open && !pending) onClose(); },
    onDiscard: () => form.reset(defaults),
  });

  function submit(values: ReviewPayload) {
    if (!target || pending) return;
    onSubmit(target.creativeId, values);
  }

  return (
    <Dialog open={!!target} onOpenChange={dismiss.requestOpenChange}>
      {target ? (
        <DialogContent aria-describedby={descriptionId} className="max-w-lg">
          <DialogTitle className="font-display text-2xl">{reviewDialogTitle(action)}</DialogTitle>
          <DialogDescription id={descriptionId} className="mt-2 text-sm text-fg-muted">
            {target.title}. The decision, the reason and the note stay with this review.
          </DialogDescription>
          <form noValidate className="mt-4 space-y-4" onKeyDown={(event) => submitOnShortcut(event)} onSubmit={form.handleSubmit(submit)}>
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
                      {...register("action")}
                      value={option}
                      disabled={pending}
                      className="size-4"
                    />
                    {reviewActionLabel(option)}
                  </label>
                ))}
              </div>
            </fieldset>

            {reasonRequired(action) ? (
              <Field label="Reason" hint="These are the reasons the server records. Choose the one that matches the problem." required error={errors.reasonCode?.message}>
                <SelectInput {...register("reasonCode")} required disabled={pending}>
                  <option value="">Choose a reason</option>
                  {allowedCodes.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
                </SelectInput>
              </Field>
            ) : null}

            <Field
              label={noteRequired(action) ? "Reviewer note (required)" : "Reviewer note (optional)"}
              hint={`Up to ${REVIEW_NOTE_MAX} characters.`}
              required={noteRequired(action)}
              error={errors.note?.message}
            >
              <Textarea
                {...register("note")}
                rows={3}
                maxLength={REVIEW_NOTE_MAX}
                required={noteRequired(action)}
                disabled={pending}
              />
            </Field>

            <UnsavedChangesBar
              dirty={isDirty}
              subject="review"
              confirming={dismiss.confirming}
              onConfirmingChange={dismiss.setConfirming}
              onDiscard={dismiss.discard}
            />

            <p role="status" aria-live="polite" className={cn("text-sm", check.ok ? "text-fg-muted" : "text-danger")}>
              {check.ok ? "Ready to send." : check.message}
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="quiet" disabled={pending} onClick={() => dismiss.requestOpenChange(false)}>Cancel</Button>
              <Button type="submit" variant={action === "reject" ? "danger" : "primary"} disabled={!check.ok || pending}>
                {pending ? "Sending…" : reviewConfirmLabel(action)}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
