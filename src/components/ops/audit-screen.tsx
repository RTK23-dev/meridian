import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, DataTable, Field, PageHeader, ScreenSkeleton, SelectInput, TextInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { downloadCsvText } from "@/lib/csv";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { hasRole } from "@/lib/meridian/access";
import { exportAuditCsv, listAuditPage } from "@/lib/meridian/observability/actions";
import { qk, userScopedQueryKey } from "@/lib/query/keys";
import { AdminOnlyNotice, RefusalNotice } from "./ops-shared";
import { exportFilename, pageSpan, timestampLabel } from "./format";
import {
  actionLabel, auditDetailsText, AUDIT_PAGE_SIZE, auditExportNote, dateRangeProblem, EMPTY_AUDIT_FILTERS, type AuditFilters,
} from "./audit-model";

type AuditEntry = Awaited<ReturnType<typeof listAuditPage>>["entries"][number];

export function AuditScreen() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [page, setPage] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const enabled = canAdmin && !!organizationId && !!user;

  const query = useQuery({
    queryKey: userScopedQueryKey(user?.id, [...qk.audit(organizationId), filters, page]),
    queryFn: () => listAuditPage({ data: { organizationId, ...filters, page } }),
    enabled,
  });
  // An export is built only when the button is pressed. Nothing is cached, so each press reads the rows again.
  const exporter = useMutation({
    mutationFn: () => exportAuditCsv({ data: { organizationId, ...filters } }),
    onSuccess: (result) => downloadCsvText(exportFilename("meridian-audit", new Date()), result.csv),
  });

  if (!workspace?.active) return null;
  if (!canAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Audit log" description="Administrative history for this workspace." />
        <AdminOnlyNotice screen="The audit log" role={role} />
      </div>
    );
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = dateRangeProblem(draft.from, draft.to);
    setFormError(problem);
    if (problem) return;
    exporter.reset();
    setPage(0);
    setFilters({ actor: draft.actor.trim(), action: draft.action.trim(), brandId: draft.brandId, from: draft.from, to: draft.to });
  }

  function clearFilters() {
    setDraft(EMPTY_AUDIT_FILTERS);
    setFilters(EMPTY_AUDIT_FILTERS);
    setFormError(null);
    setPage(0);
    exporter.reset();
  }

  const columns: ColumnDef<AuditEntry, unknown>[] = [
    { id: "when", header: "When", enableSorting: false, cell: ({ row }) => <span className="whitespace-nowrap">{timestampLabel(row.original.createdAt)}</span> },
    { id: "actor", header: "Actor", enableSorting: false, cell: ({ row }) => <span className="break-words">{row.original.actorName || row.original.actorId || "Unknown"}</span> },
    { id: "action", header: "Action", enableSorting: false, cell: ({ row }) => <span className="break-all font-mono text-xs">{actionLabel(row.original.action)}</span> },
    { id: "brand", header: "Brand", enableSorting: false, cell: ({ row }) => row.original.brandName || "Workspace" },
    {
      id: "object",
      header: "Object",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="break-all text-sm">
          {row.original.objectType || "Unknown type"} · <span className="font-mono text-xs">{row.original.objectId || "none"}</span>
        </span>
      ),
    },
    {
      id: "details",
      header: "Details",
      enableSorting: false,
      cell: ({ row }) => {
        const text = auditDetailsText(row.original.metadata);
        return <span className="break-words text-sm text-fg-muted">{text || "None recorded"}</span>;
      },
    },
  ];

  const data = query.data;
  const span = data ? pageSpan(page, AUDIT_PAGE_SIZE, data.total) : null;
  const filtered = Object.values(filters).some((value) => value !== "");
  const hasDraft = Object.values(draft).some((value) => value !== "");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Administrative history for this workspace, newest first. Entries are limited to this workspace."
      />

      <form className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2 xl:grid-cols-5" onSubmit={applyFilters} noValidate>
        <Field label="Actor name or ID">
          <TextInput value={draft.actor} maxLength={100} onChange={(event) => setDraft({ ...draft, actor: event.target.value })} />
        </Field>
        <Field label="Action" hint="Part of the action code, such as calibration or job.">
          <TextInput value={draft.action} maxLength={100} placeholder="calibration.approved" onChange={(event) => setDraft({ ...draft, action: event.target.value })} />
        </Field>
        <Field label="Brand">
          <SelectInput value={draft.brandId} onChange={(event) => setDraft({ ...draft, brandId: event.target.value })}>
            <option value="">All brands and the workspace</option>
            {workspace.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </SelectInput>
        </Field>
        <Field label="From date">
          <TextInput type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
        </Field>
        <Field label="To date">
          <TextInput type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
        </Field>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-5">
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="quiet" disabled={!filtered && !hasDraft} onClick={clearFilters}>Clear</Button>
        </div>
      </form>
      {formError ? <RefusalNotice error={new Error(formError)} /> : null}

      <section aria-labelledby="export-heading" className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h2 id="export-heading" className="text-section font-semibold">Export CSV</h2>
        <p className="text-sm text-fg-muted">
          Exports are generated when you click. The file uses the filters above and downloads to this device.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" loading={exporter.isPending} onClick={() => exporter.mutate()}>Export matching entries</Button>
        </div>
        {exporter.error ? <RefusalNotice error={exporter.error} /> : null}
        {exporter.data ? <p role="status" className="text-sm">{auditExportNote(exporter.data)}</p> : null}
      </section>

      {query.isError && !data ? <PlainErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {!data && !query.isError ? <ScreenSkeleton label="Loading audit log" shape="rows" /> : null}
      {data && span ? (
        <p className="text-sm text-fg-muted" aria-live="polite">
          {data.total === 0 ? "No entries match these filters" : `Showing ${span.first}–${span.last} of ${data.total.toLocaleString()} entries`}
        </p>
      ) : null}
      {data ? (
        <DataTable
          data={data.entries}
          columns={columns}
          getRowId={(row) => row.id}
          emptyTitle={filtered ? "No audit entries match these filters" : "No audit entries yet"}
          emptyReason={filtered ? "Clear the filters or widen the dates." : "Administrative actions in this workspace appear here."}
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
