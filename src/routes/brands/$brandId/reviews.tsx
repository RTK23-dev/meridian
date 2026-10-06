import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Notice, Panel, SelectInput, Skeleton, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { REVIEW_REASON_CODES, listReviews, resolveReview } from "@/lib/meridian/machine";
import { useReviewsQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/brands/$brandId/reviews")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Reviews brandId={brandId} />
  );
}

function Reviews({ brandId }: { brandId: string }) {
  const query = useReviewsQuery(brandId);
  const data = query.data ?? null;
  const busy = useBusy([qk.reviews(brandId), qk.opportunities(brandId), qk.studio(brandId)]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!data) return <div role="status" aria-label="Loading reviews" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(data.role, "member");
  const open = data.reviews.filter((item) => item.status === "open");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Reviews</p>
        <h1 className="font-display text-4xl">Holds a person has to clear</h1>
        <p className="text-muted">Auto-approve, human review, and reject come from thresholds on structured evidence. A model does not cast this vote.</p>
      </div>
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      {open.length === 0 ? <Panel>No open reviews.</Panel> : (
        <ul className="space-y-4">
          {open.map((item) => (
            <li key={item.id}>
              <ReviewCard
                item={item}
                canEdit={canEdit}
                pending={busy.pending}
                onResolve={(action, reasonCode, note) => {
                  void busy.run(async () => {
                    await resolveReview({ data: { brandId, reviewId: item.id, action, reasonCode, note } });
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewCard({
  item,
  canEdit,
  pending,
  onResolve,
}: {
  item: Awaited<ReturnType<typeof listReviews>>["reviews"][number];
  canEdit: boolean;
  pending: boolean;
  onResolve: (action: "approve" | "reject", reasonCode: string, note: string) => void;
}) {
  const [reason, setReason] = useState<string>(REVIEW_REASON_CODES[0] ?? "other");
  const [note, setNote] = useState("");
  return (
    <Panel>
      <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.question} · {item.decision} · answer {item.answer || "unrecorded"} · p {item.probability.toFixed(2)} · confidence {item.confidence.toFixed(2)}</p>
      <h2 className="mt-2 font-display text-2xl">{item.label || "Untitled"}</h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
        {item.reasons.map((reasonLine) => <li key={reasonLine}>{reasonLine}</li>)}
      </ul>
      {canEdit ? (
        <div className="mt-4 grid gap-3">
          <Field label="If you reject, why">
            <SelectInput value={reason} onChange={(event) => setReason(event.target.value)}>
              {REVIEW_REASON_CODES.map((code) => <option key={code} value={code}>{code.replaceAll("_", " ")}</option>)}
            </SelectInput>
          </Field>
          <Field label="Note">
            <TextInput value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => onResolve("approve", reason, note)}>Approve</Button>
            <Button variant="danger" disabled={pending} onClick={() => onResolve("reject", reason, note)}>Reject</Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
