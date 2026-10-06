import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Notice, Panel, SelectInput, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import {
  dismissOpportunity,
  refreshOpportunities,
} from "@/lib/meridian/machine";
import { useOpportunitiesQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { downloadCsv } from "@/lib/csv";

export const Route = createFileRoute("/brands/$brandId/opportunities")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Opportunities brandId={brandId} />
  );
}

function Opportunities({ brandId }: { brandId: string }) {
  const query = useOpportunitiesQuery(brandId);
  const rows = query.data?.opportunities ?? null;
  const role = query.data?.role ?? "viewer";
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [sortBy, setSortBy] = useState("rank");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const busy = useBusy([qk.opportunities(brandId), qk.studio(brandId)]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!rows) return <div role="status" aria-label="Loading opportunities" className="space-y-3"><Skeleton variant="card" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(role, "member");
  const visibleRows = rows
    .filter((item) => category === "all" || item.category === category)
    .sort((left, right) => sortBy === "confidence" ? right.confidence - left.confidence
      : sortBy === "risk" ? right.risk - left.risk
        : sortBy === "status" ? left.status.localeCompare(right.status)
          : right.expectedValue - left.expectedValue);
  const selectedOpportunity = rows.find((item) => item.id === openId) ?? null;

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
      {rows.some((item) => item.decision === "HUMAN_REVIEW" && item.status === "open") ? <Panel className="border-brass/50"><p className="font-semibold">On hold: clear under Reviews</p><p className="mt-1 text-sm text-muted">A human review decision is blocking these opportunities from moving to a brief.</p><Link className="mt-2 inline-block font-semibold underline" to="/brands/$brandId/reviews" params={{ brandId }}>Open review queue →</Link></Panel> : null}
      {rows.length === 0 ? (
        <Panel>Nothing has been scored. Scoring uses the brand brain, stored observations, and learned patterns. It does not invent competitors.</Panel>
      ) : (
        <>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Category"><SelectInput value={category} onChange={(event) => setCategory(event.currentTarget.value)}><option value="all">All categories</option><option value="discovered">Discovered</option><option value="supported">Supported</option><option value="hypothesis">Prior</option></SelectInput></Field>
          <Field label="Sort by"><SelectInput value={sortBy} onChange={(event) => setSortBy(event.currentTarget.value)}><option value="rank">Rank</option><option value="confidence">Confidence</option><option value="risk">Risk</option><option value="status">Status</option></SelectInput></Field>
          <Button type="button" variant="quiet" disabled={!visibleRows.length} onClick={() => downloadCsv("meridian-opportunities.csv", [
            { key: "label", label: "Opportunity" }, { key: "category", label: "Evidence category" }, { key: "status", label: "Status" },
            { key: "expectedValue", label: "Rank score" }, { key: "decision", label: "JEV decision" }, { key: "probability", label: "Probability" },
            { key: "confidence", label: "Evidence confidence" }, { key: "risk", label: "Risk" }, { key: "reason", label: "Reason" },
          ], visibleRows)}>Export visible opportunities</Button>
          {canEdit && selectedIds.length ? <Button disabled={busy.pending} variant="secondary" onClick={() => void busy.run(async () => { for (const opportunityId of selectedIds) await dismissOpportunity({ data: { brandId, opportunityId } }); setSelectedIds([]); })}>Dismiss selected ({selectedIds.length})</Button> : null}
          <p className="text-sm text-muted">{visibleRows.length} of {rows.length} opportunities</p>
        </div>
        <ul className="space-y-4">
          {visibleRows.map((item) => (
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
              {canEdit && ["open", "rejected"].includes(item.status) ? <label className="mt-3 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedIds((current) => checked ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id)); }} />Select for bulk dismiss</label> : null}
              <p className="mt-3">{item.reason}</p>
              {item.decision === "HUMAN_REVIEW" && item.status === "open" ? (
                <p className="mt-2 text-sm text-muted">This is on hold. Clear it under Reviews before a brief can be built.</p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setOpenId(item.id)}>Why this</Button>
                {canEdit && item.status !== "rejected" && item.status !== "dismissed" ? <Link to="/brands/$brandId/studio" params={{ brandId }} className="inline-flex min-h-11 items-center rounded-md bg-brass px-4 text-sm font-semibold text-paper">Open in Studio</Link> : null}
                {canEdit && item.status !== "rejected" && item.status !== "dismissed" ? <Button variant="quiet" disabled={busy.pending} onClick={() => void busy.run(async () => { await dismissOpportunity({ data: { brandId, opportunityId: item.id } }); })}>Dismiss</Button> : null}
              </div>
            </li>
          ))}
        </ul>
        <Sheet open={!!selectedOpportunity} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
          <SheetContent className="left-auto right-0 top-0 bottom-0 max-h-none w-full max-w-2xl rounded-none border-l border-t-0">
            {selectedOpportunity ? <>
              <SheetTitle className="font-display text-2xl">{selectedOpportunity.label}</SheetTitle>
              <SheetDescription>{selectedOpportunity.category} · {selectedOpportunity.status} · rank {selectedOpportunity.expectedValue.toFixed(2)} · JEV probability {selectedOpportunity.probability.toFixed(2)}</SheetDescription>
              <div className="mt-5 space-y-5">
                <p className="text-sm">{selectedOpportunity.reason}</p>
                <div className="h-56" role="img" aria-label="Stored opportunity scoring dimensions from zero to one"><ResponsiveContainer width="100%" height="100%"><BarChart layout="vertical" data={[
                  { name: "Brand fit", value: selectedOpportunity.brandFit }, { name: "History", value: selectedOpportunity.historicalEvidence }, { name: "Market", value: selectedOpportunity.marketSignal }, { name: "Novelty", value: selectedOpportunity.novelty }, { name: "Reproducible", value: selectedOpportunity.reproducibility }, { name: "Saturation", value: selectedOpportunity.saturation }, { name: "Risk", value: selectedOpportunity.risk },
                ]} margin={{ left: 12, right: 18, top: 8, bottom: 8 }}><CartesianGrid strokeDasharray="3 3" /><XAxis type="number" domain={[0, 1]} /><YAxis type="category" dataKey="name" width={92} /><Tooltip /><Bar dataKey="value" fill="hsl(var(--brass))" radius={[0, 4, 4, 0]}>{Array.from({ length: 7 }, (_, index) => <Cell key={index} />)}</Bar></BarChart></ResponsiveContainer></div>
                <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4"><Metric label="Brand fit" value={selectedOpportunity.brandFit} /><Metric label="History" value={selectedOpportunity.historicalEvidence} /><Metric label="Market" value={selectedOpportunity.marketSignal} /><Metric label="Novelty" value={selectedOpportunity.novelty} /><Metric label="Reproducible" value={selectedOpportunity.reproducibility} /><Metric label="Saturation" value={selectedOpportunity.saturation} /><Metric label="Risk" value={selectedOpportunity.risk} /><Metric label="Basis" value={selectedOpportunity.evidenceBasis} /></dl>
                {selectedOpportunity.researchSampleCount ? <div className="text-sm text-muted"><p>JEV Research: {selectedOpportunity.researchState} pattern · {selectedOpportunity.researchSampleCount} source ads · confidence {(selectedOpportunity.researchConfidence ?? 0).toFixed(2)}</p><details className="mt-2"><summary className="cursor-pointer">Show evidence ids</summary><p className="mt-1 break-all">Creative ids: {(selectedOpportunity.researchSourceIds ?? []).join(", ") || "not shared"}<br />Analysis ids: {(selectedOpportunity.researchAnalysisIds ?? []).join(", ") || "not shared"}</p></details></div> : null}
                <div><h3 className="font-semibold">Evidence</h3>{selectedOpportunity.evidence.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">{selectedOpportunity.evidence.map((entry) => <li key={entry.id}>{entry.summary}</li>)}</ul> : <p className="mt-1 text-sm text-muted">No evidence items are attached to this opportunity.</p>}</div>
                {canEdit && selectedOpportunity.status !== "rejected" && selectedOpportunity.status !== "dismissed" ? <div className="flex flex-wrap gap-2"><Link to="/brands/$brandId/studio" params={{ brandId }} className="inline-flex min-h-11 items-center rounded-md bg-brass px-4 text-sm font-semibold text-paper">Open in Studio</Link><Button variant="quiet" disabled={busy.pending} onClick={() => void busy.run(async () => { await dismissOpportunity({ data: { brandId, opportunityId: selectedOpportunity.id } }); setOpenId(null); })}>Dismiss</Button></div> : null}
              </div>
            </> : null}
          </SheetContent>
        </Sheet>
        </>
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
