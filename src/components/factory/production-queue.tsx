import type { UseQueryResult } from "@tanstack/react-query";
import { PlainErrorState } from "@/components/plain-error";
import { FACTORY_GRAPH } from "@/lib/meridian/factory/pipeline";
import type { BrandProductionQueue } from "@/lib/meridian/jobs/brand-queue";
import type { JobView } from "@/lib/meridian/jobs/ops";

/** The counts a person reads, in the order they are listed. Each one is written out, so no status is shown by colour alone. */
const STATUS_ORDER: ReadonlyArray<{ key: keyof BrandProductionQueue["counts"]; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "running", label: "Running" },
  { key: "retry", label: "Retrying" },
  { key: "dead", label: "Failed" },
  { key: "succeeded", label: "Succeeded" },
  { key: "cancelled", label: "Cancelled" },
];

const STATUS_TEXT: Record<string, string> = Object.fromEntries(STATUS_ORDER.map((status) => [status.key, status.label]));

/** A job's stage in the words the run list uses. A job type the graph does not name is shown as it is stored. */
function stageLabel(jobType: string): string {
  return FACTORY_GRAPH.find((spec) => spec.type === jobType)?.label ?? jobType;
}

function when(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

/**
 * The brand's production queue, from the job records. It shows the counts for every status and the most recent jobs, each with
 * its own failure reason. Nothing here is estimated: a job with no recorded error shows none.
 */
export function ProductionQueue({ query }: { query: UseQueryResult<BrandProductionQueue> }) {
  if (query.isError && !query.data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <p role="status" className="text-sm text-muted">Loading the production queue…</p>;

  const { counts, total, recent } = query.data;
  if (total === 0) return <p className="text-sm text-muted">No production jobs for this brand yet. A queued run adds its jobs here.</p>;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {STATUS_ORDER.map((status) => (
          <div key={status.key} className="rounded-md border border-line p-3">
            <dt className="text-sm text-muted">{status.label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{counts[status.key]}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">Showing the {recent.length} most recent of {total} jobs.</p>
      <ol aria-label="Recent production jobs" className="divide-y divide-line rounded-md border border-line text-sm">
        {recent.map((job: JobView) => (
          <li key={job.id} className="space-y-1 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">{stageLabel(job.jobType)}</span>
              <span>{STATUS_TEXT[job.status] ?? job.status}</span>
            </div>
            <p className="text-muted">
              Attempt {job.attempts} of {job.maxAttempts} · created {when(job.createdAt)}
              {job.cancelRequested ? " · cancellation requested" : ""}
            </p>
            {job.error ? <p className="text-danger [overflow-wrap:anywhere]">{job.error}</p> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
