import { createFileRoute } from "@tanstack/react-router";
import { Activity, AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspace } from "@/components/workspace";
import { Button, Panel, ScreenSkeleton } from "@/components/ui";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { cancelJob, retryJob } from "@/lib/meridian/jobs/actions";
import { qk } from "@/lib/query/keys";
import { useJobsQuery, useScopedMutation } from "@/lib/query/hooks";
import { statusLabel } from "@/lib/copy";

export const Route = createFileRoute("/_app/jobs")({ staticData: { pageTitle: "Jobs & health" }, component: JobsPage });

function JobsPage() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const query = useJobsQuery(organizationId);
  const data = query.data ?? null;
  // Retry and cancel refresh only the jobs list. The list polls on its own while a job is active.
  const retry = useScopedMutation({
    mutationKey: ["mutation", "jobs.retry", organizationId],
    mutationFn: (jobId: string) => retryJob({ data: { organizationId, jobId } }),
    invalidate: () => [qk.jobs(organizationId)],
    success: "Job queued again.",
  });
  const cancel = useScopedMutation({
    mutationKey: ["mutation", "jobs.cancel", organizationId],
    mutationFn: (jobId: string) => cancelJob({ data: { organizationId, jobId } }),
    invalidate: () => [qk.jobs(organizationId)],
  });
  if (query.isError && !data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading jobs and health" shape="rows" />;
  const counts = data.counts as Record<string, number>;
  const queued = (counts.queued ?? 0) + (counts.retry ?? 0);

  return (
    <div className="space-y-6">
      <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Jobs &amp; health</h1><p className="mt-2 max-w-2xl text-muted">Queue activity and worker heartbeats for this workspace. This page refreshes every 5 seconds while a job is queued or running, and when you return to it.</p></header>
      {retry.error ? <PlainErrorNotice error={retry.error} /> : null}
      {cancel.error ? <PlainErrorNotice error={cancel.error} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HealthCard label="Worker" value={statusLabel(data.worker)} icon={<Activity aria-hidden="true" />} />
        <HealthCard label="Scheduler" value={statusLabel(data.scheduler)} icon={<Clock3 aria-hidden="true" />} />
        <HealthCard label="Queued / retrying" value={String(queued)} icon={<Clock3 aria-hidden="true" />} />
        <HealthCard label="Dead letter" value={String(counts.dead ?? 0)} icon={<AlertTriangle aria-hidden="true" />} />
      </div>
      {data.jobs.length === 0 ? <Panel>No jobs are stored for this workspace.</Panel> : (
        <ul className="space-y-3">
          {data.jobs.map((job) => (
            <li key={job.id} className="rounded-lg border border-line bg-panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-xs font-semibold uppercase tracking-widest text-brass">{job.jobType} · {job.brandName}</p><h2 className="mt-1 font-display text-xl">{statusLabel(job.status)}</h2><p className="mt-1 text-sm text-muted">{job.attempts}/{job.maxAttempts} attempts · Created {new Date(job.createdAt).toLocaleString()}</p></div>
                <div className="flex gap-2">
                  {job.status === "dead" ? <Button type="button" disabled={retry.isPending} onClick={() => void retry.mutateAsync(job.id).catch(() => undefined)}>Retry job</Button> : null}
                  {job.status === "queued" || job.status === "retry" ? <Button type="button" variant="quiet" disabled={cancel.isPending || job.cancelRequested} onClick={() => void cancel.mutateAsync(job.id).catch(() => undefined)}>{job.cancelRequested ? "Cancellation requested" : "Cancel queued job"}</Button> : null}
                </div>
              </div>
              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm">Job details</summary>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted">Job ID</dt><dd className="break-all font-mono text-xs">{job.id}</dd></div>
                  <div><dt className="text-muted">Next run</dt><dd>{job.runAfter ? new Date(job.runAfter).toLocaleString() : "Not scheduled"}</dd></div>
                  <div><dt className="text-muted">Payload fields</dt><dd>{job.payloadKeys.length ? job.payloadKeys.join(", ") : "No summary available"}</dd></div>
                  <div><dt className="text-muted">Last error</dt><dd className="break-words">{job.error || "None stored"}</dd></div>
                </dl>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HealthCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  const healthy = value === "Running";
  const Icon = healthy ? CheckCircle2 : AlertTriangle;
  return <Panel><div className="flex items-center justify-between text-muted">{label}{icon}</div><p className="mt-3 flex items-center gap-2 font-display text-2xl"><Icon aria-hidden="true" className={`size-5 ${healthy ? "text-success" : "text-warning"}`} />{value}</p></Panel>;
}
