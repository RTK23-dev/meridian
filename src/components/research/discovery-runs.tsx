import { Badge } from "@/components/ui";
import { summarizeRun, type RunOutcome } from "@/lib/meridian/discovery/run-summary";
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
  not_configured: { label: "Not used (not connected)", variant: "neutral" },
  not_supported: { label: "Not used for this input", variant: "neutral" },
  failed: { label: "Failed", variant: "danger" },
};

const OUTCOME_BADGE: Record<RunOutcome, { label: string; variant: "success" | "neutral" | "danger" | "warning" }> = {
  new_evidence: { label: "New examples", variant: "success" },
  nothing_new: { label: "Nothing new", variant: "neutral" },
  blocked: { label: "Blocked", variant: "danger" },
  partial: { label: "Partly worked", variant: "warning" },
  nothing_ran: { label: "Nothing read", variant: "neutral" },
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

/**
 * The recent discovery runs of the brand. The default view answers what was found, what is new, what did not work and what to do
 * next. Each source's own row, its full seed and its reason stay one click away, and are not dropped.
 */
export function DiscoveryRunList({ runs }: { runs: readonly DiscoveryRunSummary[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-fg-muted">No runs yet for this brand. Add a public page URL above, and the result appears here.</p>;
  }
  return (
    <ul className="space-y-3">
      {runs.map((run) => {
        const summary = summarizeRun(run);
        const badge = OUTCOME_BADGE[summary.outcome];
        return (
          <li key={run.id} className="border-t border-border py-4 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <span className="text-sm font-semibold">{SCOPE_LABEL[run.scope] ?? run.scope}</span>
              <span className="text-xs text-fg-muted">{dateText(run.startedAt)}</span>
            </div>
            <p className="mt-2 text-sm">{summary.headline}</p>
            {summary.blocker ? <p className="mt-1 text-sm text-fg-muted [overflow-wrap:anywhere]">{summary.blocker}</p> : null}
            {summary.nextStep ? <p className="mt-1 text-sm text-fg-muted">{summary.nextStep}</p> : null}
            {run.sources.length > 0 ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-fg-muted">
                  Show source details ({summary.ran} read, {summary.failed} failed, {summary.notUsed} not used)
                </summary>
                <p className="mt-2 text-xs text-fg-muted [overflow-wrap:anywhere]">Asked for: {run.seeds.join(", ")}</p>
                <ul className="mt-2 space-y-2">
                  {run.sources.map((source) => {
                    const state = STATE_BADGE[source.status];
                    return (
                      <li key={`${source.adapterId}:${source.seed}`} className="border-t border-border py-2 first:border-t-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{source.adapterId}</span>
                          <Badge variant={state.variant}>{state.label}</Badge>
                          {source.status === "failed" && source.sourceStatus ? (
                            <Badge variant="warning">{HEALTH_LABEL[source.sourceStatus] ?? source.sourceStatus}</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-fg-muted [overflow-wrap:anywhere]">{source.seed}: {sourceDetail(source)}</p>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
