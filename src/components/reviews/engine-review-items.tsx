import type { EngineInboxItem } from "@/lib/meridian/reviews/engine-items";
import { formatOpened } from "./review-model";

/**
 * The video engine's open review items for the brand, read only. The engine decides them, and this list says so. Each row names the
 * engine's own reason and the request it belongs to, so a person can see what is waiting before the engine's decision reaches Meridian.
 * Nothing renders when the engine has no open item.
 */
export function EngineReviewItems({ items }: { items: readonly EngineInboxItem[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="engine-review-heading" className="max-w-3xl space-y-3">
      <div className="space-y-1">
        <h2 id="engine-review-heading" className="text-base font-semibold">From the video engine</h2>
        <p className="text-sm text-muted">
          {items.length === 1 ? "1 open item" : `${items.length} open items`}. The engine decides these. Decisions on them are not available here yet.
        </p>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border border-border bg-surface p-3">
            <p className="font-semibold">{item.label}</p>
            <p className="text-sm">{item.reason}</p>
            <p className="text-xs text-muted">
              Request {item.requestId} · opened {formatOpened(item.createdAt)}
              {item.shotId ? ` · shot ${item.shotId}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
