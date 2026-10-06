import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Authed, useBusy } from "@/components/gate";
import { useWorkspace } from "@/components/workspace";
import { StatusText } from "@/components/status";
import { Button, Notice, Panel, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { beginOauth } from "@/lib/meridian/oauth/begin";
import { refreshStoredToken } from "@/lib/meridian/oauth/refresh";
import { disconnectProvider, probeProviderConnection, reconnectProvider } from "@/lib/meridian/providers/connect";
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
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const canAdmin = workspace?.active ? hasRole(workspace.active.role, "admin") : false;
  const [data, setData] = useState<Awaited<ReturnType<typeof getSystemStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = useBusy();

  function reload() {
    return getSystemStatus({ data: { organizationId } }).then(setData);
  }

  useEffect(() => {
    let cancelled = false;
    getSystemStatus({ data: { organizationId } })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="text-muted" role="status">Loading integration status…</p>;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Integrations</p>
        <h1 className="font-display text-4xl">What is actually connected</h1>
        <p className="text-muted">
          A credential in the environment is not a connection. Status changes only after a provider request succeeds, fails, or someone disconnects.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Worker</p>
          <p className="mt-2 font-display text-2xl">{data.worker}</p>
          <p className="mt-2 text-sm text-muted">The worker is a separate process. This page only reads its heartbeat. Scheduler: {data.scheduler}. Database: {data.database}.</p>
        </Panel>
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Files</p>
          <p className="mt-2 font-display text-2xl">{data.objectStorage.active}</p>
          <p className="mt-2 text-sm text-muted">Active store: {data.objectStorage.active}. External bucket: {data.objectStorage.external}. Database blobs are a migration source, not the production default.</p>
        </Panel>
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Embeddings</p>
          <p className="mt-2 font-display text-2xl">{data.localSemantic.kind}</p>
          <p className="mt-2 text-sm text-muted">{data.localSemantic.detail} External API: {data.embeddings.status}.</p>
        </Panel>
      </div>
      {note ? <p className="text-sm" role="status">{note}</p> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      <ul className="space-y-3">
        {data.connections.map((item) => (
          <li key={item.provider} className="rounded-lg border border-line bg-panel px-4 py-3">
            <p className="font-semibold">{item.provider.replaceAll("_", " ")}</p>
            <StatusText status={item.phase} description={item.detail} />
            {item.accountName || item.accountId ? (
              <p className="text-sm">Account {item.accountName || "unnamed"} {item.accountId ? `· ${item.accountId}` : ""}</p>
            ) : null}
            {canAdmin ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy.pending || (item.provider !== "meta" && item.provider !== "tiktok" && item.provider !== "google")}
                  onClick={() => {
                    if (item.provider !== "meta" && item.provider !== "tiktok" && item.provider !== "google") return;
                    void busy.run(async () => {
                      const result = await beginOauth({ data: { organizationId, provider: item.provider, origin: window.location.origin } });
                      window.location.assign(result.url);
                    });
                  }}
                >
                  Connect
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = item.phase === "DISCONNECTED"
                        ? await reconnectProvider({ data: { organizationId, provider: item.provider } })
                        : await probeProviderConnection({ data: { organizationId, provider: item.provider } });
                      setNote(`${item.provider}: ${result.phase}. ${result.detail}`);
                      await reload();
                    });
                  }}
                >
                  {item.phase === "DISCONNECTED" ? "Reconnect" : "Test connection"}
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy.pending || item.phase === "DISCONNECTED"}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = await disconnectProvider({ data: { organizationId, provider: item.provider } });
                      setNote(`${item.provider}: ${result.detail}`);
                      await reload();
                    });
                  }}
                >
                  Disconnect
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy.pending || (item.provider !== "meta" && item.provider !== "tiktok" && item.provider !== "google")}
                  onClick={() => {
                    if (item.provider !== "meta" && item.provider !== "tiktok" && item.provider !== "google") return;
                    void busy.run(async () => {
                      const result = await refreshStoredToken({ data: { organizationId, provider: item.provider } });
                      setNote(`${item.provider}: ${result.detail}`);
                    });
                  }}
                >
                  Refresh token
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">An admin tests and disconnects providers.</p>
            )}
          </li>
        ))}
      </ul>
      <Panel>
        <h2 className="font-display text-2xl">Publishing</h2>
        <p className="mt-2 text-sm">{data.publishing.status}. {data.publishing.detail}</p>
        <p className="mt-2 text-sm text-muted">A paused campaign is created only after a healthy connection, and only with an ad account, budget, country, page, and link you supply. Meridian does not invent those. Retrying uses the stored external id and does not create a second campaign.</p>
      </Panel>
    </div>
  );
}
