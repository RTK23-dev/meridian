import { useState, type FormEvent } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, CircleAlert, Clock3, AlertTriangle } from "lucide-react";
import { Button, Card, DataTable, Field, PageHeader, SelectInput, Skeleton, StatusBadge, TextInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import type { JobView } from "@/lib/meridian/jobs/ops";
import { jobActionKey, useJobActionMutation, useJobsQuery, useWorkerHealthQuery, usePendingVariables, type JobAction } from "@/lib/query/hooks";
import { AdminOnlyNotice, RefusalNotice } from "./ops-shared";
import { JobDetailSheet } from "./job-detail-sheet";
import {
  attemptsLabel, deadLetterCopy, durationLabel, EMPTY_JOB_FILTERS, hasActiveJob, heartbeatCopy, JOB_STATUS_OPTIONS, jobActionState,
  pageSpan, queueCopy, shortJobId, timestampLabel, type HealthCopy, type JobFilters,
} from "./jobs-model";

type Message = { jobId: string; text?: string; error?: unknown };

export function JobsScreen() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const enabled = canAdmin && !!organizationId;

  const [draft, setDraft] = useState<JobFilters>(EMPTY_JOB_FILTERS);
  const [filters, setFilters] = useState<JobFilters>(EMPTY_JOB_FILTERS);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const jobs = useJobsQuery(organizationId, enabled, filters);
  const polling = hasActiveJob(jobs.data?.jobs ?? []);
  const health = useWorkerHealthQuery(organizationId, enabled, polling);
  const retry = useJobActionMutation(organizationId, "retry");
  const cancel = useJobActionMutation(organizationId, "cancel");
  const retrying = usePendingVariables<string>(jobActionKey("retry", organizationId));
  const cancelling = usePendingVariables<string>(jobActionKey("cancel", organizationId));

  const brands = workspace?.brands ?? [];
  const filtered = filters.status !== "" || filters.type !== "" || filters.brandId !== "";
  const draftFiltered = draft.status !== "" || draft.type.trim() !== "" || draft.brandId !== "";

  if (!workspace?.active) return null;
  if (!canAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Jobs & health" description="Worker heartbeats, the queue and job records for this workspace." />
        <AdminOnlyNotice screen="Jobs and health" role={role} />
      </div>
    );
  }

  function runAction(action: JobAction, job: JobView) {
    const mutation = action === "retry" ? retry : cancel;
    setMessage(null);
    mutation.mutateAsync(job.id)
      .then(() => setMessage({ jobId: job.id, text: action === "retry" ? `Job ${shortJobId(job.id)} is queued again.` : `Cancellation requested for job ${shortJobId(job.id)}.` }))
      .catch((error: unknown) => setMessage({ jobId: job.id, error }));
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setFilters({ ...draft, type: draft.type.trim(), page: 0 });
  }

  function clearFilters() {
    setDraft(EMPTY_JOB_FILTERS);
    setFilters(EMPTY_JOB_FILTERS);
  }

  const columns: ColumnDef<JobView, unknown>[] = [
    { id: "type", header: "Type", enableSorting: false, cell: ({ row }) => <span className="break-words font-medium">{row.original.jobType || "Unknown type"}</span> },
    { id: "brand", header: "Brand", enableSorting: false, cell: ({ row }) => row.original.brandName },
    { id: "status", header: "Status", enableSorting: false, cell: ({ row }) => <StatusBadge status={row.original.status} label="Status" /> },
    { id: "attempts", header: "Attempts", enableSorting: false, cell: ({ row }) => attemptsLabel(row.original.attempts, row.original.maxAttempts) },
    { id: "error", header: "Last error", enableSorting: false, cell: ({ row }) => <span className="line-clamp-2 break-words text-sm">{row.original.error || "None stored"}</span> },
    { id: "created", header: "Created", enableSorting: false, cell: ({ row }) => timestampLabel(row.original.createdAt) },
    { id: "runAfter", header: "Run after", enableSorting: false, cell: ({ row }) => timestampLabel(row.original.runAfter) },
    { id: "duration", header: "Duration", enableSorting: false, cell: ({ row }) => durationLabel(row.original.durationMs) },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const job = row.original;
        const state = jobActionState(job, canAdmin);
        const label = `${job.jobType || "job"} ${shortJobId(job.id)}`;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" aria-label={`Details for ${label}`} onClick={() => setOpenJobId(job.id)}>Details</Button>
            {state.retry ? (
              <Button type="button" size="sm" variant="secondary" aria-label={`Retry ${label}`} loading={retrying.includes(job.id)} onClick={() => runAction("retry", job)}>Retry</Button>
            ) : null}
            {state.cancel ? (
              <Button type="button" size="sm" variant="danger" aria-label={`Cancel ${label}`} loading={cancelling.includes(job.id)} onClick={() => runAction("cancel", job)}>Cancel</Button>
            ) : null}
            {state.cancelNote ? <span className="text-sm text-fg-muted">{state.cancelNote}</span> : null}
          </div>
        );
      },
    },
  ];

  const page = jobs.data;
  const span = page ? pageSpan(page.page, page.pageSize, page.total) : null;
  const shownMessage = message && message.jobId ? message : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs & health"
        description="Worker and scheduler heartbeats, the queue, and the job records for this workspace. Payload values are never shown here."
      />

      <section aria-labelledby="health-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="health-heading" className="text-section font-semibold">Worker and queue</h2>
          {health.data ? <p className="text-sm text-fg-muted">Checked {timestampLabel(health.data.checkedAt)}</p> : null}
        </div>
        {health.isError && !health.data ? <PlainErrorState error={health.error} onRetry={() => void health.refetch()} /> : null}
        {health.data ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <HealthCard label="Worker" copy={heartbeatCopy(health.data.worker)} />
            <HealthCard label="Scheduler" copy={heartbeatCopy(health.data.scheduler)} />
            <Card className="space-y-2">
              <p className="text-sm text-fg-muted">Queue depth</p>
              <p className="flex items-center gap-2 font-display text-2xl tabular-nums"><Clock3 aria-hidden="true" className="size-5 text-fg-muted" />{health.data.queue.depth}</p>
              <p className="text-sm text-fg-muted">{queueCopy(health.data.queue)}</p>
            </Card>
            <Card className="space-y-2">
              <p className="text-sm text-fg-muted">Dead letter</p>
              <p className="flex items-center gap-2 font-display text-2xl tabular-nums">
                {health.data.deadLetter > 0 ? <AlertTriangle aria-hidden="true" className="size-5 text-warning" /> : <CheckCircle2 aria-hidden="true" className="size-5 text-success" />}
                {health.data.deadLetter}
              </p>
              <p className="text-sm text-fg-muted">{deadLetterCopy(health.data.deadLetter)}</p>
            </Card>
          </div>
        ) : !health.isError ? (
          <div role="status" aria-label="Loading worker health" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((index) => <Skeleton key={index} variant="card" />)}
          </div>
        ) : null}
        {polling ? <p role="status" className="text-sm text-fg-muted">Refreshing every 5 seconds while a job is queued, retrying, or running.</p> : null}
      </section>

      {shownMessage?.error ? <RefusalNotice error={shownMessage.error} /> : null}
      {shownMessage?.text ? <p role="status" className="text-sm">{shownMessage.text}</p> : null}

      <section aria-labelledby="jobs-heading" className="space-y-3">
        <h2 id="jobs-heading" className="text-section font-semibold">Jobs</h2>
        <form className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={applyFilters}>
          <Field label="Status">
            <SelectInput value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              {JOB_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </SelectInput>
          </Field>
          <Field label="Job type" hint="Matches the type name exactly, such as publish.">
            <TextInput value={draft.type} maxLength={80} onChange={(event) => setDraft({ ...draft, type: event.target.value })} />
          </Field>
          <Field label="Brand">
            <SelectInput value={draft.brandId} onChange={(event) => setDraft({ ...draft, brandId: event.target.value })}>
              <option value="">All brands and workspace jobs</option>
              {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </SelectInput>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit">Apply filters</Button>
            <Button type="button" variant="quiet" disabled={!filtered && !draftFiltered} onClick={clearFilters}>Clear</Button>
          </div>
        </form>

        {jobs.isError && !page ? <PlainErrorState error={jobs.error} onRetry={() => void jobs.refetch()} /> : null}
        {span && page ? (
          <p className="text-sm text-fg-muted" aria-live="polite">
            {page.total === 0 ? "No jobs to show" : `Showing ${span.first}–${span.last} of ${page.total.toLocaleString()} jobs`}
          </p>
        ) : null}
        <DataTable
          data={page?.jobs ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={!page && !jobs.isError}
          emptyTitle={filtered ? "No jobs match these filters" : "No jobs are stored yet"}
          emptyReason={filtered ? "Clear the filters to see every job in this workspace." : "Jobs appear here when the workspace starts work that the worker runs."}
        />
        {page && span ? (
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="secondary" size="md" disabled={filters.page === 0 || jobs.isFetching} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous page</Button>
            <p className="text-sm text-fg-muted">Page {filters.page + 1} of {span.pageCount}</p>
            <Button type="button" variant="secondary" size="md" disabled={filters.page + 1 >= span.pageCount || jobs.isFetching} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next page</Button>
          </div>
        ) : null}
      </section>

      <JobDetailSheet
        organizationId={organizationId}
        jobId={openJobId}
        canAdmin={canAdmin}
        retrying={retrying}
        cancelling={cancelling}
        message={shownMessage}
        onRetry={(job) => runAction("retry", job)}
        onCancel={(job) => runAction("cancel", job)}
        onClose={() => setOpenJobId(null)}
      />
    </div>
  );
}

/** Running or stopped is written out, with the icon, so the state is not carried by colour alone. */
function HealthCard({ label, copy }: { label: string; copy: HealthCopy }) {
  const Icon = copy.healthy ? CheckCircle2 : CircleAlert;
  const tone = copy.healthy ? "text-success" : "text-danger";
  return (
    <Card className="space-y-2">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="flex items-center gap-2 font-display text-2xl"><Icon aria-hidden="true" className={`size-5 ${tone}`} />{copy.value}</p>
      <p className="text-sm text-fg-muted">{copy.detail}</p>
    </Card>
  );
}
