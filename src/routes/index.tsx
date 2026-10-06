import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuditList } from "@/components/audit";
import { useBusy } from "@/components/gate";
import { Button, Field, Notice, Panel, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { createOrganization } from "@/lib/meridian/api";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <Overview />
  );
}

function Overview() {
  const { data, reload } = useWorkspace();
  if (!data?.active) return <CreateWorkspace onCreated={reload} />;
  const best = data.brands.reduce((top, brand) => Math.max(top, brand.completeness), 0);
  const understood = data.brands.find((brand) => brand.completeness === best);
  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Overview</p>
        <h1 className="font-display text-4xl">What should we make next?</h1>
        <p className="text-lg text-muted">{recommendation(data.brands.length, best, understood?.name)}</p>
      </div>
      <Panel>
        <h2 className="font-display text-2xl">What is missing</h2>
        <p className="mt-2 text-muted">{recommendation(data.brands.length, best, understood?.name)}</p>
      </Panel>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="font-display text-2xl">Brands</h2>
        {hasRole(data.active.role, "member") ? (
          <Link to="/brands/new" className="inline-flex min-h-11 items-center rounded-md bg-brass px-4 text-sm font-semibold text-paper">
            New brand
          </Link>
        ) : (
          <p className="text-sm text-muted">Viewers cannot add brands.</p>
        )}
      </div>
      {data.brands.length === 0 ? (
        <Panel>
          <p>No brands yet. Add the one you actually work on. Meridian will not fill this list for you.</p>
        </Panel>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {data.brands.map((brand) => (
            <li key={brand.id}>
              <Link to="/brands/$brandId" params={{ brandId: brand.id }} className="block rounded-lg border border-line bg-panel p-5 hover:border-brass">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-2xl">{brand.name}</h3>
                  <span className="text-sm text-muted">{Math.round(brand.completeness * 100)}% known</span>
                </div>
                <p className="mt-2 text-sm text-muted">{brand.sells || brand.industry || "No description yet."}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Panel>
        <h2 className="font-display text-xl">Recent record</h2>
        <AuditList entries={data.audit} />
      </Panel>
    </div>
  );
}

function recommendation(brands: number, completeness: number, name?: string): string {
  if (brands === 0) {
    return "Create a brand first. There is no default brand, and there will not be a guessed one.";
  }
  if (completeness < 0.35) {
    return `${name ?? "This brand"} is only partly described. Creative decisions wait until audience, positioning, and voice are written.`;
  }
  return `${name ?? "The brand"} has a usable brain. Open it to record what you have seen, score opportunities from that evidence, and write results back.`;
}

function CreateWorkspace({ onCreated }: { onCreated: () => Promise<void> }) {
  const navigate = useNavigate();
  const { pending, error, run } = useBusy();
  const [name, setName] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await createOrganization({ data: { name } });
      await onCreated();
      await navigate({ to: "/" });
    });
  }
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">First step</p>
        <h1 className="font-display text-4xl">Name the workspace</h1>
        <p className="text-muted">
          A workspace holds brands. You will be the owner. Other people can be added later if they already have accounts.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Workspace name" hint="Your company, studio, or agency.">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </Button>
      </form>
    </div>
  );
}
