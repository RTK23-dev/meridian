import { createFileRoute } from "@tanstack/react-router";
import { BrandNav } from "@/components/brand-nav";
import { Authed } from "@/components/gate";
import { ErrorState, Panel, Skeleton } from "@/components/ui";
import { useIntelligenceQuery } from "@/lib/query/hooks";
import { errorText } from "@/components/ui";

export const Route = createFileRoute("/brands/$brandId/intelligence")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Intelligence brandId={brandId} />
    </Authed>
  );
}

function Intelligence({ brandId }: { brandId: string }) {
  const query = useIntelligenceQuery(brandId);
  const data = query.data ?? null;
  const error = query.error ? errorText(query.error) : null;

  if (error) return <ErrorState message={error} onRetry={() => void query.refetch()} />;
  if (!data) return <div role="status" aria-label="Loading creative intelligence" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Creative intelligence</p>
        <h1 className="font-display text-4xl">What is in the stored record</h1>
        <p className="text-muted">
          {data.semanticNote} Structured angle counts below are fingerprints. They are not a substitute for local:semantic vectors.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Competitor rows</p>
          <p className="mt-2 font-display text-3xl">{data.competitorCount}</p>
        </Panel>
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">This brand</p>
          <p className="mt-2 font-display text-3xl">{data.ownCount}</p>
        </Panel>
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Whitespace</p>
          <p className="mt-2">{data.whitespace.length === 0 ? "No competitor angle is missing from this brand." : data.whitespace.join(", ")}</p>
        </Panel>
      </div>
      {data.semanticClusters.length > 0 ? (
        <ul className="space-y-2">
          {data.semanticClusters.map((group) => (
            <li key={group.summary} className="rounded-lg border border-line bg-panel px-4 py-3 text-sm">{group.summary}</li>
          ))}
        </ul>
      ) : null}
      {data.angleClusters.length === 0 ? (
        <Panel>No creative rows yet, so there is nothing to group by angle.</Panel>
      ) : (
        <ul className="space-y-2">
          {data.angleClusters.map((group) => (
            <li key={group.key} className="rounded-lg border border-line bg-panel px-4 py-3 text-sm">
              Fingerprint {group.key} · {group.count}
            </li>
          ))}
        </ul>
      )}
      <Panel>
        <h2 className="font-display text-2xl">Notices</h2>
        {data.notifications.length === 0 ? (
          <p className="mt-2 text-muted">No notices yet.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {data.notifications.map((item) => (
              <li key={`${item.createdAt}-${item.title}`}>
                <span className="font-semibold">{item.title}</span>
                <span className="block text-muted">{item.body}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
