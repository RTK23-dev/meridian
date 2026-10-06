import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed } from "@/components/gate";
import { Notice, Panel, errorText } from "@/components/ui";
import { getIntelligence } from "@/lib/meridian/machine";

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
  const [data, setData] = useState<Awaited<ReturnType<typeof getIntelligence>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIntelligence({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="text-muted">Loading creative intelligence…</p>;

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Creative intelligence</p>
        <h1 className="font-display text-4xl">What is in the stored record</h1>
        <p className="text-muted">
          Clusters and whitespace on this screen are lexical unless a semantic vector was stored. Local semantic model: {data.neuralEmbedding}. Ad library, publishing, video generation, and the live performance feed are not connected in this workspace until a provider request succeeds. Lexical similarity is not that local model.
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
      {data.angleClusters.length === 0 ? (
        <Panel>No creative rows yet, so there is nothing to cluster.</Panel>
      ) : (
        <ul className="space-y-2">
          {data.angleClusters.map((group) => (
            <li key={group.key} className="rounded-lg border border-line bg-panel px-4 py-3 text-sm">
              {group.key} · {group.count}
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
