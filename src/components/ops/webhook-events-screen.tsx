import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, DataTable, Field, PageHeader, ScreenSkeleton, TextInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { providerLabel } from "@/lib/copy";
import { hasRole } from "@/lib/meridian/access";
import { listWebhookEvents } from "@/lib/meridian/observability/actions";
import { qk, userScopedQueryKey } from "@/lib/query/keys";
import { AdminOnlyNotice } from "./ops-shared";
import { pageSpan, timestampLabel } from "./format";

/** Copy of the server's page size for listWebhookEvents (50 rows per page). */
const WEBHOOK_PAGE_SIZE = 50;

type WebhookEvent = Awaited<ReturnType<typeof listWebhookEvents>>["events"][number];

export function WebhookEventsScreen() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const [providerDraft, setProviderDraft] = useState("");
  const [provider, setProvider] = useState("");
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: userScopedQueryKey(user?.id, [...qk.webhooks(organizationId), provider, page]),
    queryFn: () => listWebhookEvents({ data: { organizationId, provider, page } }),
    enabled: canAdmin && !!organizationId && !!user,
  });

  if (!workspace?.active) return null;
  if (!canAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Webhook events" description="Received webhook event identifiers and when they arrived." />
        <AdminOnlyNotice screen="Webhook events" role={role} />
      </div>
    );
  }

  function applyFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(0);
    setProvider(providerDraft.trim());
  }

  const columns: ColumnDef<WebhookEvent, unknown>[] = [
    { id: "received", header: "Received", enableSorting: false, cell: ({ row }) => <span className="whitespace-nowrap">{timestampLabel(row.original.receivedAt)}</span> },
    { id: "provider", header: "Provider", enableSorting: false, cell: ({ row }) => providerLabel(row.original.provider) },
    { id: "eventId", header: "Provider event ID", enableSorting: false, cell: ({ row }) => <span className="break-all font-mono text-xs">{row.original.eventId || "Not given"}</span> },
  ];

  const data = query.data;
  const span = data ? pageSpan(page, WEBHOOK_PAGE_SIZE, data.total) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhook events"
        description="Each row is a webhook that arrived, with its provider event ID and the time it was received. The index does not record whether an event was processed, and it does not store payloads."
      />

      <form className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={applyFilter}>
        <Field label="Provider" hint="The provider key as stored, such as meta or tiktok. Leave empty for all providers.">
          <TextInput value={providerDraft} maxLength={80} placeholder="meta" onChange={(event) => setProviderDraft(event.target.value)} />
        </Field>
        <Button type="submit">Apply filter</Button>
      </form>

      {query.isError && !data ? <PlainErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {!data && !query.isError ? <ScreenSkeleton label="Loading webhook events" shape="rows" /> : null}
      {span && data ? (
        <p className="text-sm text-fg-muted" aria-live="polite">
          {data.total === 0 ? "No webhook events match" : `Showing ${span.first}–${span.last} of ${data.total.toLocaleString()} events`}
        </p>
      ) : null}
      {data ? (
        <DataTable
          data={data.events}
          columns={columns}
          getRowId={(row) => row.id}
          emptyTitle={provider ? "No events for this provider" : "No webhook events are recorded"}
          emptyReason="Events appear here after a provider sends a webhook to this workspace."
        />
      ) : null}
      {data && span ? (
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="secondary" size="md" disabled={page === 0 || query.isFetching} onClick={() => setPage(page - 1)}>Previous page</Button>
          <p className="text-sm text-fg-muted">Page {page + 1} of {span.pageCount}</p>
          <Button type="button" variant="secondary" size="md" disabled={page + 1 >= span.pageCount || query.isFetching} onClick={() => setPage(page + 1)}>Next page</Button>
        </div>
      ) : null}
    </div>
  );
}
