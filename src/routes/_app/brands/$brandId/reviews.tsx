import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel as ResizablePanel, Separator } from "react-resizable-panels";
import { Inbox } from "lucide-react";
import { EmptyState, ScreenSkeleton } from "@/components/ui";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { ReviewDetail } from "@/components/reviews/review-detail";
import { ReviewInbox } from "@/components/reviews/review-inbox";
import {
  EMPTY_REVIEW_DRAFT,
  REVIEW_LIST_LIMIT,
  isQueueConfirmedEmpty,
  isTypingTarget,
  openCountLabel,
  triageAction,
  type ReviewDraft,
  type ReviewRow,
} from "@/components/reviews/review-model";
import { useMediaQuery } from "@/lib/use-media-query";
import { hasRole } from "@/lib/meridian/access";
import { useResolveReview, usePendingVariables, useReviewsQuery } from "@/lib/query/hooks";

export const Route = createFileRoute("/_app/brands/$brandId/reviews")({ staticData: { pageTitle: "Reviews" }, component: Page });

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
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [reasonErrorFor, setReasonErrorFor] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 1024px)");
  const canEdit = data ? hasRole(data.role, "member") : false;
  const open = useMemo(() => data?.reviews.filter((item) => item.status === "open") ?? [], [data?.reviews]);
  const index = Math.min(selectedIndex, Math.max(open.length - 1, 0));
  const selected = open[index] ?? null;
  const selectedId = selected?.id ?? null;

  const draftFor = (id: string): ReviewDraft => drafts[id] ?? EMPTY_REVIEW_DRAFT;
  const patchDraft = (id: string, patch: Partial<ReviewDraft>) => {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_REVIEW_DRAFT), ...patch } }));
  };

  // A reject needs a reason the reviewer chose. Without one, the reason field is focused and says so, and nothing is sent.
  const decide = useCallback((item: ReviewRow, action: "approve" | "reject") => {
    const draft = drafts[item.id] ?? EMPTY_REVIEW_DRAFT;
    if (action === "reject" && !draft.reason) {
      setReasonErrorFor(item.id);
      document.getElementById(`review-reason-${item.id}`)?.focus();
      return;
    }
    void resolveReviewAsync({
      reviewId: item.id,
      action,
      reasonCode: action === "approve" ? draft.reason || "other" : draft.reason,
      note: draft.note,
    }).catch(() => undefined);
  }, [drafts, resolveReviewAsync]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = triageAction(event.key, {
        canDecide: canEdit,
        typing: isTypingTarget(event.target as HTMLElement | null),
        modifier: event.metaKey || event.ctrlKey || event.altKey,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "next") { setSelectedIndex(Math.min(index + 1, Math.max(open.length - 1, 0))); return; }
      if (action === "previous") { setSelectedIndex(Math.max(index - 1, 0)); return; }
      if (selected) decide(selected, action);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEdit, decide, index, open.length, selected]);

  // Keeps the keyboard-selected row in view in the inbox.
  useEffect(() => {
    if (selectedId) document.getElementById(`review-option-${selectedId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (query.isError && !data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading reviews" shape="rows" />;

  const now = new Date();
  const loaded = data.reviews.length;
  const resolvedInList = loaded - open.length;
  const confirmedEmpty = isQueueConfirmedEmpty({ loaded, open: open.length, limit: REVIEW_LIST_LIMIT });
  const detail = selected ? (
    <ReviewDetail
      key={selected.id}
      item={selected}
      now={now}
      canEdit={canEdit}
      pending={resolving.includes(selected.id)}
      draft={draftFor(selected.id)}
      reasonError={reasonErrorFor === selected.id}
      onDraftChange={(patch) => patchDraft(selected.id, patch)}
      onApprove={() => decide(selected, "approve")}
      onReject={() => decide(selected, "reject")}
    />
  ) : null;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Reviews</p>
        <h1 className="font-display text-4xl">Holds a person has to clear</h1>
        <p className="text-muted">Auto-approve, human review, and reject come from thresholds on structured evidence. A model does not cast this vote. Use <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>a</kbd> to approve, and <kbd>r</kbd> to reject. A reject needs a reason.</p>
      </div>
      {resolve.error ? <PlainErrorNotice error={resolve.error} /> : null}
      {open.length === 0 ? (
        confirmedEmpty ? (
          <EmptyState
            icon={<Inbox aria-hidden="true" className="size-5" />}
            title="Queue clear"
            reason={loaded === 0
              ? "0 open reviews. No reviews have been created for this brand yet."
              : `0 open reviews. ${resolvedInList} resolved in the list. Nothing is waiting for a person.`}
          />
        ) : (
          <EmptyState
            icon={<Inbox aria-hidden="true" className="size-5" />}
            title={`No open reviews in the ${REVIEW_LIST_LIMIT} most recent`}
            reason="Older reviews are not loaded here, so this does not confirm the queue is empty. Reload the page after a while to check again."
          />
        )
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted" aria-live="polite">
            {openCountLabel(open.length, loaded, REVIEW_LIST_LIMIT)}{resolvedInList > 0 ? `, ${resolvedInList} resolved in the list` : ""}.
          </p>
          {wide ? (
            <Group orientation="horizontal" className="min-h-[32rem] items-stretch gap-2">
              <ResizablePanel defaultSize="36%" minSize="24%" className="min-w-0">
                <div className="max-h-[75vh] overflow-y-auto pr-2">
                  <ReviewInbox items={open} selectedIndex={index} now={now} onSelect={setSelectedIndex} />
                </div>
              </ResizablePanel>
              <Separator aria-label="Resize the review list" className="relative w-2 shrink-0 rounded-full bg-border hover:bg-border-strong focus-visible:outline-2 focus-visible:outline-accent before:absolute before:inset-y-0 before:-inset-x-2 before:content-[''] pointer-coarse:before:-inset-x-[18px]" />
              <ResizablePanel defaultSize="64%" minSize="40%" className="min-w-0">
                <div className="max-h-[75vh] overflow-y-auto pl-1">{detail}</div>
              </ResizablePanel>
            </Group>
          ) : (
            <div className="space-y-4">
              <ReviewInbox items={open} selectedIndex={index} now={now} onSelect={setSelectedIndex} />
              {detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
