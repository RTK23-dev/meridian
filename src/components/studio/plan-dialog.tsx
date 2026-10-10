import { useId } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, Textarea } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { useDirtyDismiss } from "@/components/forms/use-dirty-dismiss";
import { planCostText } from "./plan-cost.ts";

/** The optional reason for rejecting a plan. The dialog stops at 200 characters, as it always has. */
const planReasonSchema = z.object({
  reason: z.string().trim().max(200, "Use 200 characters or fewer."),
});

export type PlanDeliverable = { id?: string; kind?: string; title?: string; provider?: string; aspectRatio?: string };

export type PlanShape = {
  scope?: string;
  autonomy?: string;
  deliverables?: PlanDeliverable[];
  estimatedCost?: { totalEstimatedUsd?: number; unpricedDeliverableIds?: string[] };
};

export type PendingPlan = {
  planId: string;
  plan: PlanShape | null;
  estimatedCostUsd?: number;
  note?: string;
};

type PlanDialogProps = {
  plan: PendingPlan | null;
  approving: boolean;
  rejecting: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onClose: () => void;
};

/** A plan waiting for approval before billable generation. Approval and rejection are the only ways out. */
export function PlanDialog({ plan, approving, rejecting, onApprove, onReject, onClose }: PlanDialogProps) {
  const form = useForm<{ reason: string }>({ resolver: zodResolver(planReasonSchema), defaultValues: { reason: "" }, mode: "onChange" });
  const { register, formState: { errors, isDirty } } = form;
  const descriptionId = useId();
  const busy = approving || rejecting;
  const dismiss = useDirtyDismiss({
    dirty: isDirty && !!plan,
    onOpenChange: (open) => { if (!open && !busy) onClose(); },
    onDiscard: () => form.reset({ reason: "" }),
  });
  // Reject is a button, not a submit, so Cmd+Enter cannot reject a plan by accident.
  const rejectPlan = form.handleSubmit((values) => onReject(values.reason));
  return (
    <Dialog open={!!plan} onOpenChange={dismiss.requestOpenChange}>
      {plan ? (
        <DialogContent aria-describedby={descriptionId} className="max-w-xl">
          <DialogTitle className="font-display text-2xl">Review creative plan</DialogTitle>
          <DialogDescription id={descriptionId} className="mt-2 text-sm text-fg-muted">
            {plan.note || "Review the planned deliverables and estimated cost before billable generation starts."}
          </DialogDescription>
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex justify-between gap-3 border-b border-border py-2">
              <span className="text-fg-muted">Plan ID</span>
              <span className="break-all font-mono text-xs">{plan.planId}</span>
            </div>
            <div className="flex justify-between gap-3 border-b border-border py-2">
              <span className="text-fg-muted">Scope and autonomy</span>
              <span className="font-medium">{plan.plan?.scope || "auto_choose"} · {plan.plan?.autonomy || "semi_automatic"}</span>
            </div>
            <div className="flex justify-between gap-3 border-b border-border py-2">
              <span className="text-fg-muted">Estimated cost</span>
              <span className="text-right font-semibold">{planCostText(plan)}</span>
            </div>
            <div>
              <h3 className="mb-2 font-semibold">Planned deliverables ({plan.plan?.deliverables?.length ?? 0})</h3>
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {plan.plan?.deliverables?.map((deliverable, index) => (
                  <li key={deliverable.id || index} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-xs">
                    <div>
                      <span className="mr-2 font-semibold uppercase text-accent">{deliverable.kind}</span>
                      <span>{deliverable.title || `Deliverable ${index + 1}`}</span>
                    </div>
                    <span className="text-fg-muted">{deliverable.provider} · {deliverable.aspectRatio || "9:16"}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Field label="Reason for rejecting (optional)" hint="Recorded with the rejection if you give one." error={errors.reason?.message}>
              <Textarea {...register("reason")} rows={2} maxLength={200} disabled={busy} />
            </Field>
            <UnsavedChangesBar
              dirty={isDirty}
              subject="rejection reason"
              confirming={dismiss.confirming}
              onConfirmingChange={dismiss.setConfirming}
              onDiscard={dismiss.discard}
            />
            <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-4">
              <Button type="button" variant="quiet" disabled={busy} onClick={() => void rejectPlan()}>
                {rejecting ? "Rejecting…" : "Reject plan"}
              </Button>
              <Button type="button" disabled={busy} onClick={onApprove}>
                {approving ? "Executing…" : "Approve and generate"}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
