import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui";
import type { AuditEntry } from "@/lib/meridian/workspace/actions";
import { relativeTime } from "./home-model";
import { describeAudit } from "./activity-model";

/** The recent workspace actions, read as sentences. The full trail lives on the audit page. */
export function ActivityFeed({ entries, brandNameById }: { entries: AuditEntry[]; brandNameById: Map<string, string> }) {
  return (
    <Card id="recent-activity" aria-labelledby="activity-title" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="activity-title" className="text-section font-semibold">Recent activity</h2>
          <p className="mt-1 text-sm text-fg-muted">Recorded actions from this workspace audit trail.</p>
        </div>
        <Link to="/audit" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">View all</Link>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-fg-muted">No actions recorded yet.</p>
      ) : (
        <ol className="divide-y divide-border">
          {entries.map((entry) => {
            const line = describeAudit(entry, entry.brandId ? brandNameById.get(entry.brandId) ?? null : null);
            return (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-3 text-sm">
                <p className="min-w-0">
                  <strong className="font-semibold text-fg">{line.actor}</strong>{" "}
                  <span className="text-fg">{line.sentence}</span>
                  {line.brandName ? <span className="text-fg-muted"> · {line.brandName}</span> : null}
                </p>
                <time dateTime={entry.createdAt} className="shrink-0 text-xs text-fg-muted">{relativeTime(entry.createdAt)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
