import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { useBusy } from "@/components/gate";
import { useWorkspace } from "@/components/workspace";
import { Button, ErrorState, Notice, Panel, Skeleton, errorText } from "@/components/ui";
import { cancelJob, listJobs, retryJob } from "@/lib/meridian/jobs/actions";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { qk, userScopedQueryKey } from "@/lib/query/keys";
import { statusLabel } from "@/lib/copy";

export const Route = createFileRoute("/jobs")({ component: JobsPage });

function JobsPage() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const queryKey = userScopedQueryKey(user?.id, qk.jobs(organizationId));
  const query = useQuery({
    queryKey,
    queryFn: () => listJobs({ data: { organizationId } }),
    enabled: !!user && !!organizationId,
    refetchInterval: 10_000,
  });
  const data = query.data ?? null;
  const busy = useBusy([qk.jobs(organizationId)]);
  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!data) return <div role="status" aria-label="Loading jobs and health" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const counts = data.counts as Record<string, number>;
  const queued = (counts.queued ?? 0) + (counts.retry ?? 0);

  async function runAction(action: () => Promise<unknown>) {
    await busy.run(async () => { await action(); await query.refetch(); });
  }

  return (
    <div className="space-y-6">
      <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Jobs &amp; health</h1><p className="mt-2 max-w-2xl text-muted">Queue activity and worker heartbeats for this workspace. Health updates every 10 seconds.</p></header>
      {busy.error ? <Notice>{busy.error}</Notice> : null}
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
                  {job.status === "dead" ? <Button type="button" disabled={busy.pending} onClick={() => void runAction(() => retryJob({ data: { organizationId, jobId: job.id } }))}>Retry job</Button> : null}
                  {job.status === "queued" || job.status === "retry" ? <Button type="button" variant="quiet" disabled={busy.pending || job.cancelRequested} onClick={() => void runAction(() => cancelJob({ data: { organizationId, jobId: job.id } }))}>{job.cancelRequested ? "Cancellation requested" : "Cancel queued job"}</Button> : null}
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
