import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import { decideDeliveryApproval } from "@/lib/meridian/content-factory/actions";
import { REJECT_REASON_MIN } from "@/lib/meridian/content-factory/approval";

export type ReviewItem = { sessionId: string; title: string; angle: string | null; approval: "approved" | "rejected" | "not_decided" | null };

const APPROVAL_LABEL = { approved: "Approved", rejected: "Rejected", not_decided: "Not decided yet" } as const;
const APPROVAL_VARIANT = { approved: "success", rejected: "danger", not_decided: "neutral" } as const;

/**
 * The delivered videos of a batch, one card each, with the person's decision. Only a video the engine has delivered appears here; a video
 * that is not delivered is never shown as ready to review. Approving is gated by rights on the server, and a rejection needs its reason.
 * Opening a video goes to its own screen, which plays the delivered file and can revise it.
 */
export function BatchReview({ items, busy, onOpen, onDecided }: { items: ReviewItem[]; busy: boolean; onOpen: (sessionId: string) => void; onDecided: () => Promise<void> }) {
  const delivered = items.filter((item) => item.approval !== null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(sessionId: string, decision: "approved" | "rejected") {
    setWorking(true);
    setError(null);
    try {
      await decideDeliveryApproval({ data: { sessionId, decision, reason: decision === "rejected" ? reason : "" } });
      setRejecting(null);
      setReason("");
      await onDecided();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The decision was not saved.");
    } finally {
      setWorking(false);
    }
  }

  if (delivered.length === 0) {
    return <p className="text-sm text-fg-muted">No video in this batch has been delivered yet, so there is nothing to review. Delivered videos appear here for you to approve or reject.</p>;
  }
  const decided = delivered.filter((item) => item.approval !== "not_decided").length;
  return (
    <section aria-labelledby="batch-review-title" className="space-y-3">
      <h4 id="batch-review-title" className="text-sm font-semibold">Review delivered videos</h4>
      <p className="text-sm text-fg-muted">{decided} of {delivered.length} decided. Approve a video you would use, or reject it with a reason.</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {delivered.map((item) => (
          <li key={item.sessionId} className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 font-semibold">{item.title}</p>
              <Badge variant={APPROVAL_VARIANT[item.approval ?? "not_decided"]}>{APPROVAL_LABEL[item.approval ?? "not_decided"]}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(item.sessionId)}>Open and play<span className="sr-only"> {item.title}</span></Button>
              <Button type="button" size="sm" disabled={busy || working || item.approval === "approved"} onClick={() => void decide(item.sessionId, "approved")}>Approve<span className="sr-only"> {item.title}</span></Button>
              <Button type="button" size="sm" variant="quiet" disabled={busy || working || item.approval === "rejected"} onClick={() => { setRejecting(item.sessionId); setReason(""); setError(null); }}>Reject<span className="sr-only"> {item.title}</span></Button>
            </div>
            {rejecting === item.sessionId ? (
              <div className="space-y-2">
                <label className="block text-sm font-semibold" htmlFor={`reject-${item.sessionId}`}>Why is it rejected?</label>
                <textarea id={`reject-${item.sessionId}`} className="w-full rounded-md border border-border-strong bg-overlay p-2" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
                <p className="text-fg-muted">At least {REJECT_REASON_MIN} characters. The reason stays on record.</p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={working || reason.trim().length < REJECT_REASON_MIN} onClick={() => void decide(item.sessionId, "rejected")}>Reject with this reason</Button>
                  <Button type="button" size="sm" variant="quiet" onClick={() => setRejecting(null)}>Cancel</Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {error !== null ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </section>
  );
}
