import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, CircleCheck, Clock3, PlugZap, ServerCrash, Sparkles } from "lucide-react";
import { Badge, EmptyState, ErrorState } from "@/components/ui";
import type { AttentionItem, AttentionTarget, ReviewLoad } from "./home-model";

type SourceState = "loading" | "error" | "ready";

/** Each item links to the screen that fixes it. The link names that screen, so the detail text does not repeat the fix. */
export function AttentionList({ items, reviews, connections, onRetryReviews, onRetryConnections }: {
  items: AttentionItem[];
  reviews: ReviewLoad;
  connections: SourceState;
  onRetryReviews: () => void;
  onRetryConnections: () => void;
}) {
  const reviewsReady = reviews.status === "ready";
  const allReady = reviewsReady && connections === "ready";
  return (
    <section aria-labelledby="attention-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="attention-title" className="text-section font-semibold">Needs attention</h2>
          <p className="mt-1 text-sm text-fg-muted">Only recorded work and stored connection states appear here.</p>
        </div>
        {items.length > 0 ? <Badge variant="danger">{items.length} item{items.length === 1 ? "" : "s"}</Badge> : null}
      </div>
      {reviews.status === "error" ? <ErrorState message="Review counts could not be loaded." onRetry={onRetryReviews} /> : null}
      {connections === "error" ? <ErrorState message="Integration connection states could not be loaded." onRetry={onRetryConnections} /> : null}
      {allReady && items.length === 0 ? (
        <EmptyState icon={<CircleCheck aria-hidden="true" className="size-5" />} title="You’re up to date" reason="There are no open reviews, failed jobs, failed providers, or thin brand brains to resolve." />
      ) : null}
      {items.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((item) => <AttentionLink key={item.id} item={item} />)}
        </ul>
      ) : null}
    </section>
  );
}

const TARGET_LABEL: Record<AttentionTarget, string> = {
  "/jobs": "Open jobs",
  "/integrations": "Open integrations",
  "/brands/$brandId/reviews": "Open reviews",
  "/brands/$brandId/brain": "Open brand brain",
};

function iconFor(item: AttentionItem) {
  if (item.id.startsWith("reviews:")) return <Clock3 aria-hidden="true" className="size-5" />;
  if (item.id.startsWith("jobs:")) return <ServerCrash aria-hidden="true" className="size-5" />;
  if (item.id.startsWith("brain:")) return <Sparkles aria-hidden="true" className="size-5" />;
  if (item.tone === "danger") return <AlertCircle aria-hidden="true" className="size-5" />;
  return <PlugZap aria-hidden="true" className="size-5" />;
}

const ICON_TONE: Record<AttentionItem["tone"], string> = { accent: "text-accent", danger: "text-danger", neutral: "text-fg-muted" };

function AttentionLink({ item }: { item: AttentionItem }) {
  return (
    <li>
      <Link
        to={item.to as never}
        params={item.brandId ? { brandId: item.brandId } as never : undefined}
        className="flex h-full min-h-11 gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent"
      >
        <span className={`mt-0.5 shrink-0 ${ICON_TONE[item.tone]}`}>{iconFor(item)}</span>
        <span className="min-w-0 flex-1">
          <strong className="block text-sm font-semibold text-fg">{item.title}</strong>
          <span className="mt-1 block text-sm text-fg-muted">{item.detail}</span>
          <span className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent">
            {TARGET_LABEL[item.to]} <ArrowRight aria-hidden="true" className="size-4" />
          </span>
        </span>
      </Link>
    </li>
  );
}
