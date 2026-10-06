import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Authed } from "@/components/gate";
import { Notice, Panel, errorText } from "@/components/ui";
import { getSystemStatus } from "@/lib/meridian/system";

export const Route = createFileRoute("/integrations")({ component: Page });

function Page() {
  return (
    <Authed>
      <Integrations />
    </Authed>
  );
}

function Integrations() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getSystemStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSystemStatus({ data: {} })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="text-muted">Loading integrations…</p>;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Integrations</p>
        <h1 className="font-display text-4xl">What is actually connected</h1>
        <p className="text-muted">
          A provider that exists in code is not the same as a provider that is connected. Nothing on this page is a live ad account unless its status says so.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Worker</p>
          <p className="mt-2 font-display text-2xl">{data.worker}</p>
          <p className="mt-2 text-sm text-muted">Learning and blocked jobs are claimed inside the running app. A separate process only recovers expired leases when a real database is configured.</p>
        </Panel>
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Files</p>
          <p className="mt-2 font-display text-2xl">{data.objectStorage.database}</p>
          <p className="mt-2 text-sm text-muted">Brand files are stored in the database. External bucket: {data.objectStorage.external}.</p>
        </Panel>
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Embeddings</p>
          <p className="mt-2 font-display text-2xl">{data.embeddings.status}</p>
          <p className="mt-2 text-sm text-muted">{data.embeddings.detail}</p>
        </Panel>
      </div>
      <Panel>
        <h2 className="font-display text-2xl">Publishing</h2>
        <p className="mt-2 text-sm">{data.publishing.status}. {data.publishing.detail}</p>
      </Panel>
      <ul className="space-y-2">
        {data.integrations.map((item) => (
          <li key={item.id} className="rounded-lg border border-line bg-panel px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.status}</p>
            <p className="font-semibold">{item.id.replaceAll("_", " ")}</p>
            <p className="text-sm text-muted">{item.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
