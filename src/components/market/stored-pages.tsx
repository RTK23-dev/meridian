import type { UseQueryResult } from "@tanstack/react-query";
import { PlainErrorState } from "@/components/plain-error";
import { Button } from "@/components/ui";
import type { DiscoveredItemRow } from "@/lib/meridian/discovery/item-list";

function when(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

/**
 * The pages and posts a discovery run stored for this brand. Page text is untrusted, so each title, excerpt and address is shown
 * as plain text. "Use as observation" fills the observation form from the page; a member still chooses the competitor, angle and
 * hook, and ranking reads the page only once it is stored as an observation.
 */
export function StoredPages({
  query,
  canEdit,
  onUse,
}: {
  query: UseQueryResult<DiscoveredItemRow[]>;
  canEdit: boolean;
  onUse: (item: DiscoveredItemRow) => void;
}) {
  if (query.isError && !query.data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <p role="status" className="text-sm text-muted">Loading the stored pages…</p>;
  if (query.data.length === 0) {
    return <p className="text-sm text-muted">No pages or posts are stored for this brand yet. A discovery run stores them here.</p>;
  }

  return (
    <ol aria-label="Stored pages and posts" className="divide-y divide-border rounded-md border border-border">
      {query.data.map((item) => (
        <li key={item.id} className="space-y-2 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="min-w-0 font-semibold [overflow-wrap:anywhere]">{item.title || "Untitled page"}</p>
            <span className="text-xs text-muted">{item.source} · {when(item.discoveredAt)}</span>
          </div>
          {item.excerpt ? <p className="text-sm [overflow-wrap:anywhere]">{item.excerpt}</p> : null}
          <p className="text-xs text-muted [overflow-wrap:anywhere]">{item.url}</p>
          {canEdit ? (
            <Button type="button" variant="quiet" size="sm" onClick={() => onUse(item)}>
              Use as observation<span className="sr-only"> for {item.title || item.url}</span>
            </Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
