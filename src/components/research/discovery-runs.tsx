import { Badge, StatusBadge } from "@/components/ui";
import type { DiscoveryRunSummary } from "@/lib/meridian/discovery/run-listing";
import type { SourceRunState } from "@/lib/meridian/discovery/types";

const SCOPE_LABEL: Record<string, string> = {
  url_list: "Public page",
  niche: "Search phrase",
  scrape_page: "Public page",
  page_plus_links: "Page and links",
  domain: "Domain",
  profile: "Profile",
};

const STATE_BADGE: Record<SourceRunState["status"], { label: string; variant: "success" | "neutral" | "danger" }> = {
  ran: { label: "Ran", variant: "success" },
  not_configured: { label: "Not connected", variant: "neutral" },
  not_supported: { label: "Not supported", variant: "neutral" },
  failed: { label: "Failed", variant: "danger" },
};

/** The provider health a failed call recorded, in words a person can act on. */
const HEALTH_LABEL: Record<string, string> = {
  AUTH_FAILED: "Key rejected",
  RATE_LIMITED: "Rate limited",
  UNAVAILABLE: "Unavailable",
};

function dateText(value: string | null): string {
  if (!value) return "Not finished";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

function sourceDetail(source: SourceRunState): string {
  if (source.status === "ran") return `${source.itemsFound} stored, ${source.seenBefore} already stored for this brand`;
  return source.reason;
}

/** The recent discovery runs of the brand. Every source in a run shows its own state, and why it did not run. */
export function DiscoveryRunList({ runs }: { runs: readonly DiscoveryRunSummary[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-fg-muted">No discovery runs yet for this brand. A run appears here with each source's state.</p>;
  }
  return (
    <ul className="space-y-3">
      {runs.map((run) => (
        <li key={run.id} className="border-t border-border py-4 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} label="Run status" />
            <span className="text-sm font-semibold">{SCOPE_LABEL[run.scope] ?? run.scope}</span>
            <span className="text-sm text-fg-muted [overflow-wrap:anywhere]">{run.seeds.join(", ")}</span>
          </div>
          <p className="mt-1 text-xs text-fg-muted">Started {dateText(run.startedAt)} · {run.discoveredUrls} stored · {run.seenBefore} already stored</p>
          {run.caveat ? <p className="mt-2 text-sm">{run.caveat}</p> : null}
          {run.sources.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {run.sources.map((source) => {
                const badge = STATE_BADGE[source.status];
                return (
                  <li key={`${source.adapterId}:${source.seed}`} className="border-t border-border py-2 text-sm first:border-t-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{source.adapterId}</span>
                      <span className="text-fg-muted [overflow-wrap:anywhere]">{source.seed}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {source.status === "failed" && source.sourceStatus ? (
                        <Badge variant="warning">{HEALTH_LABEL[source.sourceStatus] ?? source.sourceStatus}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-fg-muted [overflow-wrap:anywhere]">{sourceDetail(source)}</p>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
