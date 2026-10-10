import { useState } from "react";
import { useBusy } from "@/components/gate";
import { Button, Notice, Panel, Skeleton, TextArea, errorText } from "@/components/ui";
import { hasRole, type Role } from "@/lib/meridian/access";
import { reviewStudioBrief } from "@/lib/meridian/studio/actions";
import { useBriefReviewQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

const MIN_REASON = 20;

/**
 * The review of a brief the decision engine could not judge. It shows the failure, the unresolved questions, and the evidence
 * that was provided. Planning and production stay blocked until an admin records an explicit decision here. The control is
 * shown only to admins; the server enforces the same rule.
 */
export function BriefReviewPanel({ brandId, briefId, title, role }: { brandId: string; briefId: string; title: string; role: Role }) {
  const review = useBriefReviewQuery(brandId, briefId);
  const action = useBusy([qk.studio(brandId), qk.briefReview(brandId, briefId)]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const canReview = hasRole(role, "admin");
  const data = review.data;

  function decide(decision: "approve" | "reject") {
    void action.run(async () => {
      await reviewStudioBrief({ data: { brandId, briefId, action: decision, reason: reason.trim(), acknowledged } });
      setAcknowledged(false);
      setReason("");
    });
  }

  return (
    <Panel className="space-y-4" aria-labelledby={`brief-review-${briefId}`}>
      <div>
        <h2 id={`brief-review-${briefId}`} className="font-display text-xl">Held for review: {title}</h2>
        <p className="mt-1 text-sm text-muted">
          The decision engine could not judge this brief. Planning and production are blocked until a person reviews it.
        </p>
      </div>
      {review.isPending ? <Skeleton variant="card" /> : null}
      {review.error ? <Notice>{errorText(review.error)}</Notice> : null}
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
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>I have read the failure, the unresolved questions, and the evidence above.</span>
              </label>
              <label className="block text-sm">
                <span className="text-muted">Reason (at least {MIN_REASON} characters). This is recorded with your review.</span>
                <TextArea className="mt-1" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              {action.error ? <Notice>{action.error}</Notice> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={action.pending || !acknowledged || reason.trim().length < MIN_REASON} onClick={() => decide("approve")}>
                  Approve for production
                </Button>
                <Button type="button" variant="quiet" disabled={action.pending || !acknowledged || reason.trim().length < MIN_REASON} onClick={() => decide("reject")}>
                  Reject brief
                </Button>
              </div>
            </div>
          ) : data.reviewable ? (
            <Notice>An admin or owner must review this brief before it can be used.</Notice>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
