import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { Button, ErrorState, Panel, Skeleton, TextInput, errorText } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { listWebhookEvents } from "@/lib/meridian/observability/actions";
import { qk, userScopedQueryKey } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/webhooks")({ staticData: { pageTitle: "Webhook events" }, component: WebhooksPage });

function WebhooksPage() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const [providerDraft, setProviderDraft] = useState("");
  const [provider, setProvider] = useState("");
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: userScopedQueryKey(user?.id, [...qk.webhooks(organizationId), provider, page]),
    queryFn: () => listWebhookEvents({ data: { organizationId, provider, page } }),
    enabled: !!user && !!organizationId,
  });
  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!query.data) return <div role="status" aria-label="Loading webhook events"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const pageCount = Math.max(1, Math.ceil(query.data.total / 50));
  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Webhook events</h1><p className="mt-2 max-w-2xl text-muted">Received event identifiers and timestamps. Payloads are not stored by this event index.</p></header>
    <form className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-4" onSubmit={(event) => { event.preventDefault(); setPage(0); setProvider(providerDraft.trim()); }}>
      <label className="min-w-56 flex-1 text-sm">Provider filter<TextInput value={providerDraft} onChange={(event) => setProviderDraft(event.target.value)} placeholder="meta" /></label>
      <Button type="submit">Apply filter</Button>
    </form>
    <p className="text-sm text-muted">{query.data.total.toLocaleString()} matching event{query.data.total === 1 ? "" : "s"} · page {page + 1} of {pageCount}</p>
    {query.data.events.length ? <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[36rem] text-left text-sm"><thead className="bg-paper text-muted"><tr><th className="px-4 py-3 font-medium">Received</th><th className="px-4 py-3 font-medium">Provider</th><th className="px-4 py-3 font-medium">Event ID</th></tr></thead><tbody>{query.data.events.map((event) => <tr key={event.id} className="border-t border-line"><td className="whitespace-nowrap px-4 py-3">{new Date(event.receivedAt).toLocaleString()}</td><td className="px-4 py-3">{event.provider}</td><td className="break-all px-4 py-3 font-mono text-xs">{event.eventId}</td></tr>)}</tbody></table></div> : <Panel>No webhook event identifiers are recorded for this workspace.</Panel>}
    <div className="flex justify-between"><Button type="button" variant="quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button type="button" variant="quiet" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>;
}
