import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { BrandNav } from "@/components/brand-nav";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { REVIEW_REASON_CODES, listReviews } from "@/lib/meridian/machine";
import { useResolveReview, usePendingVariables, useReviewsQuery } from "@/lib/query/hooks";
import { Term } from "@/components/term";

export const Route = createFileRoute("/_app/brands/$brandId/reviews")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Reviews brandId={brandId} />
  );
}

function Reviews({ brandId }: { brandId: string }) {
  const query = useReviewsQuery(brandId);
  const data = query.data ?? null;
  // Approve and reject are optimistic: the row leaves the open list at once and returns if the server refuses.
  const resolve = useResolveReview(brandId);
  const resolving = usePendingVariables<{ reviewId: string }>(["mutation", "review.resolve", brandId]).map((vars) => vars.reviewId);
  const { mutateAsync: resolveReviewAsync } = resolve;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const canEdit = data ? hasRole(data.role, "member") : false;
  const open = useMemo(() => data?.reviews.filter((item) => item.status === "open") ?? [], [data?.reviews]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']") || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") { event.preventDefault(); setSelectedIndex((index) => Math.min(index + 1, Math.max(open.length - 1, 0))); }
      if (event.key === "k") { event.preventDefault(); setSelectedIndex((index) => Math.max(index - 1, 0)); }
      const item = open[selectedIndex];
      if (!item || !canEdit) return;
      if (event.key.toLowerCase() === "a") void resolveReviewAsync({ reviewId: item.id, action: "approve", reasonCode: "other", note: "" }).catch(() => undefined);
      if (event.key.toLowerCase() === "r") void resolveReviewAsync({ reviewId: item.id, action: "reject", reasonCode: REVIEW_REASON_CODES[0] ?? "other", note: "" }).catch(() => undefined);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, selectedIndex, canEdit, resolveReviewAsync]);

  if (query.isError && !data) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading reviews" shape="rows" />;

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Reviews</p>
        <h1 className="font-display text-4xl">Holds a person has to clear</h1>
        <p className="text-muted">Auto-approve, human review, and reject come from thresholds on structured evidence. A model does not cast this vote. Use <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>a</kbd> to approve, and <kbd>r</kbd> to reject.</p>
      </div>
      {resolve.error ? <Notice>{errorText(resolve.error)}</Notice> : null}
      {open.length === 0 ? <Panel>No open reviews.</Panel> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.6fr)]">
          <nav aria-label="Review inbox" className="space-y-2">
            {open.map((item, index) => <button key={item.id} type="button" aria-current={index === selectedIndex ? "true" : undefined} onClick={() => setSelectedIndex(index)} className={`w-full rounded-lg border p-3 text-left ${index === selectedIndex ? "border-brass bg-panel" : "border-line"}`}>
              <span className="block truncate font-semibold">{item.label || "Untitled review"}</span>
              <span className="mt-1 block text-xs text-muted">{formatDistanceToNowStrict(new Date(item.createdAt), { addSuffix: true })} · {item.decision} · {item.question}</span>
              <span className="mt-2 inline-flex rounded-full border border-line px-2 py-0.5 text-xs">{item.confidence >= 0.8 ? "High confidence" : item.confidence >= 0.5 ? "Review" : "Low confidence"}</span>
            </button>)}
          </nav>
          {open[selectedIndex] ? <ReviewCard item={open[selectedIndex]} canEdit={canEdit} pending={resolving.includes(open[selectedIndex].id)} onResolve={(action, reasonCode, note) => { void resolveReviewAsync({ reviewId: open[selectedIndex].id, action, reasonCode, note }).catch(() => undefined); }} /> : null}
        </div>
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
    <Panel aria-label="Selected review">
      <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.question} · {item.decision} · answer {item.answer || "unrecorded"} · score {item.probability.toFixed(2)} · <Term id="confidence" /> {item.confidence.toFixed(2)}</p>
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
