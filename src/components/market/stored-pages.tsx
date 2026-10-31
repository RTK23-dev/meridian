import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { PlainErrorState } from "@/components/plain-error";
import { Button } from "@/components/ui";
import { getDiscoveredItemProvenance } from "@/lib/meridian/discovery/item-actions";
import type { DiscoveredItemRow } from "@/lib/meridian/discovery/item-list";
import type { SourceProvenance } from "@/lib/meridian/discovery/provenance";

function when(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

/** "Where it was seen": the runs that observed this page. Loaded only when the member opens it. Plain text only. */
function SeenIn({ brandId, itemId }: { brandId: string; itemId: string }) {
  const [open, setOpen] = useState(false);
  const provenance = useQuery({
    queryKey: ["discovery", "provenance", brandId, itemId],
    queryFn: () => getDiscoveredItemProvenance({ data: { brandId, itemId } }),
    enabled: open,
  });
  return (
    <details className="text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-muted">Where it was seen</summary>
      <SeenInBody query={provenance} />
    </details>
  );
}

function SeenInBody({ query }: { query: UseQueryResult<SourceProvenance | null> }) {
  if (query.isError) return <p className="pt-2 text-muted">Could not read the runs for this page. Try again later.</p>;
  if (query.data === undefined) return <p className="pt-2 text-muted">Loading…</p>;
  if (query.data === null || query.data.observations.length === 0) {
    return <p className="pt-2 text-muted">No run has recorded this page.</p>;
  }
  const { runIds, observations } = query.data;
  return (
    <div className="space-y-2 pt-2">
      <p>Seen in {runIds.length} {runIds.length === 1 ? "run" : "runs"}.</p>
      <ol className="list-decimal space-y-1 pl-5">
        {observations.map((observation, index) => (
          <li key={`${observation.runId}-${index}`}>
            {observation.seenBefore ? "Found again" : "Stored the page"} on {when(observation.discoveredAt)}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The pages and posts a discovery run stored for this brand. Page text is untrusted, so each title, excerpt and address is shown
 * as plain text. "Use as observation" fills the observation form from the page; a member still chooses the competitor, angle and
 * hook, and ranking reads the page only once it is stored as an observation.
 */
export function StoredPages({
  brandId,
  query,
  canEdit,
  onUse,
}: {
  brandId: string;
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
          <SeenIn brandId={brandId} itemId={item.id} />
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
