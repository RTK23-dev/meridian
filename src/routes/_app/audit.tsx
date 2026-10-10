import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useWorkspace } from "@/components/workspace";
import { Button, Field, Panel, Skeleton, TextInput } from "@/components/ui";
import { auditFilterSchema, type AuditFilterInput } from "@/components/forms/client-schemas";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { PlainErrorState } from "@/components/plain-error";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { listAuditPage } from "@/lib/meridian/observability/actions";
import { qk, userScopedQueryKey } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/audit")({ staticData: { pageTitle: "Audit log" }, component: AuditPage });

type Filters = { actor: string; action: string; brandId: string; from: string; to: string };
const EMPTY_FILTERS: Filters = { actor: "", action: "", brandId: "", from: "", to: "" };
const EMPTY_DRAFT: AuditFilterInput = { ...EMPTY_FILTERS };

function AuditPage() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const filterForm = useForm<AuditFilterInput>({ resolver: zodResolver(auditFilterSchema), defaultValues: EMPTY_DRAFT, mode: "onBlur" });
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: userScopedQueryKey(user?.id, [...qk.audit(organizationId), filters, page]),
    queryFn: () => listAuditPage({ data: { organizationId, ...filters, page } }),
    enabled: !!user && !!organizationId,
  });
  if (query.error) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <div role="status" aria-label="Loading audit log"><Skeleton variant="line" /><Skeleton variant="card" /></div>;

  const data = query.data;
  const pageCount = Math.max(1, Math.ceil(data.total / 50));
  const errors = filterForm.formState.errors;
  function submit(values: AuditFilterInput) {
    setPage(0);
    setFilters({ actor: values.actor.trim(), action: values.action.trim(), brandId: values.brandId.trim(), from: values.from, to: values.to });
  }

  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Audit log</h1><p className="mt-2 max-w-2xl text-muted">Workspace administrative history. Entries are scoped to this workspace and shown newest first.</p></header>
    <form onSubmit={filterForm.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} noValidate className="grid gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-2 xl:grid-cols-5">
      <Field label="Actor name or ID" error={errors.actor?.message}><TextInput {...filterForm.register("actor")} maxLength={100} /></Field>
      <Field label="Action" error={errors.action?.message}><TextInput {...filterForm.register("action")} maxLength={100} placeholder="decision.approved" /></Field>
      <Field label="Brand ID" error={errors.brandId?.message}><TextInput {...filterForm.register("brandId")} /></Field>
      <Field label="From" error={errors.from?.message}><TextInput {...filterForm.register("from")} type="date" /></Field>
      <Field label="To" error={errors.to?.message}><TextInput {...filterForm.register("to")} type="date" /></Field>
      <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-5"><Button type="submit" disabled={filterForm.formState.isSubmitting}>Apply filters</Button><Button type="button" variant="quiet" disabled={!data.entries.length} onClick={() => downloadCsv(data.entries)}>Download this page as CSV</Button></div>
    </form>
    <p className="text-sm text-muted">{data.total.toLocaleString()} matching entr{data.total === 1 ? "y" : "ies"} · page {page + 1} of {pageCount}</p>
    {data.entries.length === 0 ? <Panel>No audit entries match these filters.</Panel> : <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[58rem] text-left text-sm"><thead className="bg-paper text-muted"><tr><th className="px-4 py-3 font-medium">When</th><th className="px-4 py-3 font-medium">Actor</th><th className="px-4 py-3 font-medium">Action</th><th className="px-4 py-3 font-medium">Brand</th><th className="px-4 py-3 font-medium">Object</th><th className="px-4 py-3 font-medium">Metadata</th></tr></thead><tbody>{data.entries.map((entry) => <tr key={entry.id} className="border-t border-line align-top"><td className="whitespace-nowrap px-4 py-3">{new Date(entry.createdAt).toLocaleString()}</td><td className="px-4 py-3">{entry.actorName || entry.actorId}</td><td className="px-4 py-3">{entry.action}</td><td className="px-4 py-3">{entry.brandName || "Workspace"}</td><td className="px-4 py-3">{entry.objectType} · <span className="font-mono text-xs">{entry.objectId}</span></td><td className="max-w-64 break-words px-4 py-3 text-xs text-muted">{formatMetadata(entry.metadata)}</td></tr>)}</tbody></table></div>}
    <div className="flex items-center justify-between"><Button type="button" variant="quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button type="button" variant="quiet" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>;
}

function downloadCsv(rows: Awaited<ReturnType<typeof listAuditPage>>["entries"]) {
  const columns = ["createdAt", "actorName", "actorId", "action", "brandName", "objectType", "objectId", "metadata"] as const;
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const content = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(column === "metadata" ? JSON.stringify(row.metadata) : row[column])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "meridian-audit-page.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function formatMetadata(metadata: Record<string, string>) {
  const entries = Object.entries(metadata);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(" · ") : "—";
}
