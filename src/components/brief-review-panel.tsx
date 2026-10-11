import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, DisabledReason, ErrorState, Field, ErrorNotice, Card, Skeleton, Textarea } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { hasRole, type Role } from "@/lib/meridian/access";
import { reviewStudioBrief } from "@/lib/meridian/studio/actions";
import { useBriefReviewQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

const MIN_REASON = 20;

/** reviewStudioBrief: the reason is trimmed and cut at 4000 characters, and the acknowledgement is recorded as given. */
const briefReviewSchema = z.object({
  acknowledged: z.boolean().refine((value) => value, "Confirm that you have read the failure, the questions and the evidence."),
  reason: z.string().trim()
    .min(MIN_REASON, `Write at least ${MIN_REASON} characters.`)
    .max(4000, "Use 4000 characters or fewer."),
});

type BriefReviewInput = z.input<typeof briefReviewSchema>;

/**
 * The review of a brief the decision engine could not judge. It shows the failure, the unresolved questions, and the evidence
 * that was provided. Planning and production stay blocked until an admin records an explicit decision here. The control is
 * shown only to admins; the server enforces the same rule.
 */
export function BriefReviewPanel({ brandId, briefId, title, role }: { brandId: string; briefId: string; title: string; role: Role }) {
  const review = useBriefReviewQuery(brandId, briefId);
  const blankReview: BriefReviewInput = { acknowledged: false, reason: "" };
  const form = useForm<BriefReviewInput>({ resolver: zodResolver(briefReviewSchema), defaultValues: blankReview, mode: "onChange" });
  const { register, formState: { errors, isDirty } } = form;
  const acknowledged = form.watch("acknowledged");
  const reason = form.watch("reason") ?? "";
  const decision = useScopedMutation({
    mutationKey: ["mutation", "brief-review.decide", brandId, briefId],
    mutationFn: (vars: { action: "approve" | "reject"; reason: string; acknowledged: boolean }) => reviewStudioBrief({ data: { brandId, briefId, ...vars } }),
    invalidate: () => [qk.studio(brandId), qk.briefReview(brandId, briefId)],
    onSuccess: () => form.reset(blankReview),
  });
  const canReview = hasRole(role, "admin");
  const data = review.data;
  const canDecide = !decision.isPending && acknowledged && reason.trim().length >= MIN_REASON;

  async function decide(action: "approve" | "reject") {
    // Both decisions read the same checked fields, so a decision cannot be sent with a missing tick or a short reason.
    const valid = await form.trigger();
    if (!valid) return;
    const values = form.getValues();
    await decision.mutateAsync({ action, reason: values.reason.trim(), acknowledged: values.acknowledged === true }).catch(() => undefined);
  }

  return (
    <Card className="space-y-4" aria-labelledby={`brief-review-${briefId}`}>
      <div>
        <h2 id={`brief-review-${briefId}`} className="font-display text-xl">Held for review: {title}</h2>
        <p className="mt-1 text-sm text-muted">
          The decision engine could not judge this brief. Planning and production are blocked until a person reviews it.
        </p>
      </div>
      {review.isPending ? <Skeleton variant="card" /> : null}
      {review.isError && !data ? <ErrorState message="This brief review could not be loaded." onRetry={() => void review.refetch()} /> : null}
      {data ? (
        <>
          <dl className="grid gap-2 text-sm md:grid-cols-2">
            <div><dt className="text-muted">Decision</dt><dd>{data.decision}</dd></div>
            <div><dt className="text-muted">Engine</dt><dd>{data.engineId ?? "None was called"}</dd></div>
            <div><dt className="text-muted">Failure</dt><dd>{data.failureKind ?? "No provider failure. Questions were unresolved."}</dd></div>
            <div><dt className="text-muted">Policy</dt><dd>{data.policyVersion ?? "Not recorded"}</dd></div>
          </dl>
          {data.reasons.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">Why it is held</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{data.reasons.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
          ) : null}
          {data.unresolved.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">Questions the engine did not answer</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {data.unresolved.map((item) => (
                  <li key={item.questionId}><span className="font-mono">{item.questionId}</span>: {item.status}. {item.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <h3 className="text-sm font-medium">Evidence that was provided</h3>
            {data.evidence.length === 0 ? <p className="mt-1 text-sm text-muted">No evidence was recorded.</p> : (
              <ul className="mt-1 space-y-1 text-sm">
                {data.evidence.map((item) => (
                  <li key={`${item.name}-${item.timestampMs ?? ""}`}>
                    {item.name}{item.timestampMs !== undefined ? ` at ${item.timestampMs}ms` : ""}{item.sha256 ? ` (sha256 ${item.sha256.slice(0, 12)}…)` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {data.reviews.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">Reviews recorded</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {data.reviews.map((item) => (
                  <li key={item.createdAt}>{item.action} by {item.reviewerRole}{item.reviewerIsCreator ? " (the creator)" : ""}: {item.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {data.reviewable && canReview ? (
            <div className="space-y-3 border-t border-border pt-4">
              <UnsavedChangesGuard dirty={isDirty} />
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" {...register("acknowledged")} />
                  <span>I have read the failure, the unresolved questions, and the evidence above.</span>
                </label>
                {errors.acknowledged?.message ? <p role="alert" className="text-sm text-danger">{errors.acknowledged.message}</p> : null}
              </div>
              <Field label="Reason" hint={`At least ${MIN_REASON} characters. This is recorded with your review.`} error={errors.reason?.message}>
                <Textarea rows={3} {...register("reason")} />
              </Field>
              <FormDiscardBar dirty={isDirty} subject="brief review" onDiscard={() => form.reset(blankReview)} />
              {decision.error ? <PlainErrorNotice error={decision.error} /> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" disabled={!canDecide} aria-describedby={canDecide ? undefined : "brief-decision-reason"} onClick={() => void decide("approve")}>
                  {decision.isPending ? "Sending…" : "Approve for production"}
                </Button>
                <Button type="button" variant="quiet" disabled={!canDecide} aria-describedby={canDecide ? undefined : "brief-decision-reason"} onClick={() => void decide("reject")}>
                  Reject brief
                </Button>
                {canDecide || decision.isPending ? null : (
                  <DisabledReason id="brief-decision-reason" className="basis-full">
                    To enable these decisions, tick the acknowledgement above and write a reason of at least {MIN_REASON} characters.
                  </DisabledReason>
                )}
              </div>
            </div>
          ) : data.reviewable ? (
            <ErrorNotice>An admin or owner must review this brief before it can be used.</ErrorNotice>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
