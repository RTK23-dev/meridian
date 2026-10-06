import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Notice, Panel, Skeleton, TextArea, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { deleteBrand, updateBrand } from "@/lib/meridian/api";
import { brainCompleteness } from "@/lib/meridian/brain";
import type { MachineSnapshot } from "@/lib/meridian/machine";
import { errorText } from "@/components/ui";
import { useBrandQuery, useMachineQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/brands/$brandId/")({ component: BrandPage });

function BrandPage() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <BrandHome brandId={brandId} />
    </Authed>
  );
}

function BrandHome({ brandId }: { brandId: string }) {
  const detailQuery = useBrandQuery(brandId);
  const machineQuery = useMachineQuery(brandId);
  const detail = detailQuery.data ?? null;
  const machine = machineQuery.data ?? null;
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  const { pending, error: saveError, run } = useBusy([qk.brand(brandId), qk.machine(brandId)]);

  if (detailQuery.error) return <ErrorState message={errorText(detailQuery.error)} onRetry={() => void detailQuery.refetch()} />;
  if (!detail) return <div role="status" aria-label="Loading brand" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const known = brainCompleteness(detail.brain);
  const canEdit = hasRole(detail.identity.role, "member");
  const canDelete = hasRole(detail.identity.role, "admin");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      await updateBrand({
        data: {
          brandId,
          name: String(form.get("name") ?? ""),
          description: String(form.get("description") ?? ""),
          category: String(form.get("category") ?? ""),
          industry: String(form.get("industry") ?? ""),
          website: String(form.get("website") ?? ""),
          country: String(form.get("country") ?? ""),
          sells: String(form.get("sells") ?? ""),
          targetCustomers: detail?.brain.targetCustomers ?? "",
        },
      });
      await reload();
    });
  }

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/" className="text-sm text-muted">All brands</Link>
          <h1 className="font-display text-4xl">{detail.identity.name}</h1>
          <p className="text-muted">{known.filled} of {known.total} brain fields written. Version {detail.version || 1}.</p>
        </div>
      </div>
      {machine ? <NextStep brandId={brandId} snapshot={machine} filled={known.filled} /> : null}
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <Field label="Name">
          <TextInput name="name" defaultValue={detail.identity.name} required disabled={!canEdit} />
        </Field>
        <Field label="Website">
          <TextInput name="website" defaultValue={detail.identity.website} disabled={!canEdit} />
        </Field>
        <Field label="Industry">
          <TextInput name="industry" defaultValue={detail.identity.industry} disabled={!canEdit} />
        </Field>
        <Field label="Category">
          <TextInput name="category" defaultValue={detail.identity.category} disabled={!canEdit} />
        </Field>
        <Field label="Country or market">
          <TextInput name="country" defaultValue={detail.identity.country} disabled={!canEdit} />
        </Field>
        <div className="md:col-span-2">
          <Field label="What you sell">
            <TextArea name="sells" defaultValue={detail.identity.sells} disabled={!canEdit} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Description">
            <TextArea name="description" defaultValue={detail.identity.description} disabled={!canEdit} />
          </Field>
        </div>
        {saveError ? <div className="md:col-span-2"><Notice>{saveError}</Notice></div> : null}
        {canEdit ? <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save identity"}</Button> : null}
      </form>
      {canDelete ? (
        <Button
          variant="danger"
          type="button"
          onClick={() => {
            if (!window.confirm(`Delete ${detail.identity.name}? It leaves the library but stays in the audit log.`)) return;
            void run(async () => {
              await deleteBrand({ data: { brandId } });
              await reload();
              await navigate({ to: "/" });
            });
          }}
        >
          Delete brand
        </Button>
      ) : null}
    </div>
  );
}

function NextStep({ brandId, snapshot, filled }: { brandId: string; snapshot: MachineSnapshot; filled: number }) {
  const steps = [
    { done: filled >= 4, label: "Write positioning, audience, and voice", to: "/brands/$brandId/brain" as const },
    { done: snapshot.counts.observations > 0, label: "Record a competitor ad you have seen", to: "/brands/$brandId/market" as const },
    { done: snapshot.operating.generationRuns > 0, label: "Open Studio and make image and video variants", to: "/brands/$brandId/studio" as const },
  ];
  const next = steps.find((step) => !step.done);
  const recommendation = snapshot.operating.recommendation;
  const missing = [
    filled < 4 ? "Brand brain is thin. Positioning, audience, and voice are not written." : "",
    snapshot.counts.observations === 0 ? "No competitor ad is stored. An empty market is not a whitespace finding." : "",
    snapshot.operating.generationRuns === 0 ? "No generation run is stored." : "",
    snapshot.counts.reviews === 0 ? "Nothing is waiting in review." : "",
    snapshot.operating.publishedTests === 0 ? "Nothing has a stored publisher id." : "",
    snapshot.counts.performanceRows === 0 ? "No performance row is stored." : "",
    snapshot.counts.patterns === 0 ? "No learned pattern has met the sample rule." : "",
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {snapshot.counts.observations} competitor observations, {snapshot.counts.openOpportunities} open opportunities, {snapshot.counts.reviews} reviews, {snapshot.counts.patterns} learned patterns.
      </p>
      {next ? (
        <p>Next: <Link to={next.to} params={{ brandId }} className="font-semibold">{next.label}</Link></p>
      ) : (
        <p>Stored evidence is in place. <Link to="/brands/$brandId/studio" params={{ brandId }} className="font-semibold">Studio</Link> ranks what to make next.</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <h2 className="font-display text-xl">What Meridian recommends</h2>
          {recommendation ? (
            <>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-brass">{recommendation.category || "stored"} · {recommendation.angle}</p>
              <p className="mt-2 font-semibold">{recommendation.label}</p>
              <p className="mt-2 text-sm">{recommendation.reason}</p>
              <p className="mt-2 text-sm text-muted">Rank {recommendation.expectedValue.toFixed(2)}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">No opportunity is stored yet. Scoring waits for a brand brain and observations.</p>
          )}
        </Panel>
        <Panel>
          <h2 className="font-display text-xl">What needs review</h2>
          <p className="mt-2 text-sm">{snapshot.counts.reviews === 0 ? "The review queue is empty." : `${snapshot.counts.reviews} open review${snapshot.counts.reviews === 1 ? "" : "s"}.`}</p>
          {snapshot.counts.reviews > 0 ? <Link className="mt-2 inline-block text-sm font-semibold" to="/brands/$brandId/studio" params={{ brandId }}>Review in Studio</Link> : null}
        </Panel>
        <Panel>
          <h2 className="font-display text-xl">What is being made</h2>
          <p className="mt-2 text-sm">{snapshot.operating.generationRuns === 0 ? "No generation run is stored." : `${snapshot.operating.generationRuns} generation run${snapshot.operating.generationRuns === 1 ? "" : "s"} stored.`}</p>
        </Panel>
        <Panel>
          <h2 className="font-display text-xl">What is live</h2>
          <p className="mt-2 text-sm">{snapshot.operating.publishedTests === 0 ? "No publisher id is stored for this brand." : `${snapshot.operating.publishedTests} stored publication id${snapshot.operating.publishedTests === 1 ? "" : "s"}.`}</p>
        </Panel>
        <Panel>
          <h2 className="font-display text-xl">What happened</h2>
          <p className="mt-2 text-sm">{snapshot.counts.performanceRows === 0 ? "No performance row is stored." : `${snapshot.counts.performanceRows} performance row${snapshot.counts.performanceRows === 1 ? "" : "s"} tied to creatives.`}</p>
        </Panel>
        <Panel>
          <h2 className="font-display text-xl">What Meridian learned</h2>
          {snapshot.operating.learning.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No pattern has met the sample rule.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {snapshot.operating.learning.map((pattern) => (
                <li key={pattern.summary}>{pattern.lift >= 0 ? "+" : "−"} {pattern.summary}</li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      {missing.length > 0 ? (
        <Panel>
          <h2 className="font-display text-xl">What is missing</h2>
          <ul className="mt-2 space-y-1 text-sm">{missing.map((line) => <li key={line}>{line}</li>)}</ul>
        </Panel>
      ) : null}
    </div>
  );
}
