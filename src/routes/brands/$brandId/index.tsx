import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, Field, Notice, TextArea, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { deleteBrand, getBrand, updateBrand, type BrandDetail } from "@/lib/meridian/api";
import { brainCompleteness } from "@/lib/meridian/brain";
import { getMachine, type MachineSnapshot } from "@/lib/meridian/machine";
import { errorText } from "@/components/ui";

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
  const [detail, setDetail] = useState<BrandDetail | null>(null);
  const [machine, setMachine] = useState<MachineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  const { pending, error: saveError, run } = useBusy();

  useEffect(() => {
    let cancelled = false;
    getBrand({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    getMachine({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setMachine(next);
      })
      .catch(() => {
        if (!cancelled) setMachine(null);
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!detail) return <p className="text-muted">Loading brand…</p>;
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
      const next = await getBrand({ data: { brandId } });
      setDetail(next);
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
      {machine ? <MachineStrip snapshot={machine} /> : null}
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

function MachineStrip({ snapshot }: { snapshot: MachineSnapshot }) {
  const steps = [
    ["Brain", "Open"],
    ["Market", snapshot.counts.observations > 0 ? `${snapshot.counts.observations} observations` : "No observations"],
    ["Opportunities", snapshot.counts.openOpportunities > 0 ? `${snapshot.counts.openOpportunities} open` : "Not scored"],
    ["Reviews", snapshot.counts.reviews > 0 ? `${snapshot.counts.reviews} waiting` : "None waiting"],
    ["Library", snapshot.counts.creatives > 0 ? `${snapshot.counts.creatives} creatives` : "Empty"],
    ["Learning", snapshot.counts.patterns > 0 ? `${snapshot.counts.patterns} patterns` : snapshot.counts.performanceRows > 0 ? "Results not computed" : "No results"],
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Text model: {snapshot.providerConfigured ? snapshot.provider : "not configured"}. Ad library: not connected.
      </p>
      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map(([title, state]) => (
          <li key={title} className="rounded-lg border border-line bg-panel p-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-brass">{state}</p>
            <h2 className="mt-2 font-display text-xl">{title}</h2>
          </li>
        ))}
      </ol>
    </div>
  );
}
