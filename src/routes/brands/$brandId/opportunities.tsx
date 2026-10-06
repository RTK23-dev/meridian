import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, ErrorState, Notice, Panel, Skeleton, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import {
  dismissOpportunity,
  refreshOpportunities,
} from "@/lib/meridian/machine";
import { useOpportunitiesQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/brands/$brandId/opportunities")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Opportunities brandId={brandId} />
    </Authed>
  );
}

function Opportunities({ brandId }: { brandId: string }) {
  const query = useOpportunitiesQuery(brandId);
  const rows = query.data?.opportunities ?? null;
  const role = query.data?.role ?? "viewer";
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const busy = useBusy([qk.opportunities(brandId), qk.studio(brandId)]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!rows) return <div role="status" aria-label="Loading opportunities" className="space-y-3"><Skeleton variant="card" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(role, "member");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-3">
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Opportunities</p>
          <h1 className="font-display text-4xl">What to make next</h1>
          <p className="text-muted">
            Each card is ranked from stored evidence. A hypothesis is not a market finding. Refresh replaces open cards. Accepted work is kept.
            Make image and video variants in <Link className="font-semibold" to="/brands/$brandId/studio" params={{ brandId }}>Studio</Link>, not from a script form.
          </p>
        </div>
        {canEdit ? (
          <Button
            disabled={busy.pending}
            onClick={() => {
              void busy.run(async () => {
                const result = await refreshOpportunities({ data: { brandId } });
                setNote(`${result.count} candidates scored. Priors stay labeled as priors. An angle is added only when stored observations or a learned pattern contain it.`);
              });
            }}
          >
            {busy.pending ? "Scoring…" : "Score from evidence"}
          </Button>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      {rows.length === 0 ? (
        <Panel>Nothing has been scored. Scoring uses the brand brain, stored observations, and learned patterns. It does not invent competitors.</Panel>
      ) : (
        <ul className="space-y-4">
          {rows.map((item) => (
            <li key={item.id} className="rounded-lg border border-line bg-panel p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-brass">
                    {item.category === "discovered" ? "Discovered" : item.category === "hypothesis" ? "Prior" : "Supported"} · {item.decision || item.status}
                  </p>
                  <h2 className="font-display text-2xl">{item.label}</h2>
                </div>
                <p className="text-sm text-muted">
                  Rank {item.expectedValue.toFixed(2)}
                  {item.decision ? ` · JEV ${item.decision} ${item.probability.toFixed(2)}` : ""}
                  {" "}· evidence confidence {item.confidence.toFixed(2)}
                </p>
              </div>
              <p className="mt-3">{item.reason}</p>
              {item.decision === "HUMAN_REVIEW" && item.status === "open" ? (
                <p className="mt-2 text-sm text-muted">This is on hold. Clear it under Reviews before a brief can be built.</p>
              ) : null}
              {openId === item.id ? (
                <div className="mt-4 space-y-4">
                  <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                    <Metric label="Brand fit" value={item.brandFit} />
                    <Metric label="History" value={item.historicalEvidence} />
                    <Metric label="Market" value={item.marketSignal} />
                    <Metric label="Novelty" value={item.novelty} />
                    <Metric label="Reproducible" value={item.reproducibility} />
                    <Metric label="Saturation" value={item.saturation} />
                    <Metric label="Risk" value={item.risk} />
                    <Metric label="Basis" value={item.evidenceBasis} />
                  </dl>
                  {item.researchSampleCount ? <p className="text-sm text-muted">JEV Research: {item.researchState} pattern · {item.researchSampleCount} source ads · confidence {(item.researchConfidence ?? 0).toFixed(2)} · creative ids {(item.researchSourceIds ?? []).join(", ") || "not shared"} · analysis ids {(item.researchAnalysisIds ?? []).join(", ") || "not shared"}</p> : null}
                  <div>
                    <h3 className="font-semibold">Why</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                      {item.evidence.map((entry) => (
                        <li key={entry.id}>{entry.summary}</li>
                      ))}
                    </ul>
                  </div>
                  {canEdit && item.status !== "rejected" && item.status !== "dismissed" ? (
                    <div className="flex flex-wrap gap-2">
                      <Link to="/brands/$brandId/studio" params={{ brandId }} className="inline-flex min-h-11 items-center rounded-md bg-brass px-4 text-sm font-semibold text-paper">
                        Make image and video variants in Studio
                      </Link>
                      <Button variant="quiet" disabled={busy.pending} onClick={() => void busy.run(async () => {
                        await dismissOpportunity({ data: { brandId, opportunityId: item.id } });
                      })}>
                        Dismiss
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <Button className="mt-4" variant="quiet" onClick={() => setOpenId(item.id)}>
                  Why this
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{typeof value === "number" ? value.toFixed(2) : value}</dd>
    </div>
  );
}
