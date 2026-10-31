import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { getEngineStageMetrics, listEngineDeadJobs, replayEngineDeadJob } from "@/lib/meridian/engine-ops/actions";
import type { DeadJob } from "@/engine/ops/deadletter.ts";
import type { StageMetricsReport } from "@/engine/ops/metrics-sql.ts";
import { RefusalNotice } from "./ops-shared";

/** Milliseconds as seconds with one decimal place, or "not enough data" when the stage has no timing yet. */
function seconds(ms: number | null): string {
  return ms === null ? "not enough data" : `${(ms / 1000).toFixed(1)} s`;
}

function percent(rate: number | null): string {
  return rate === null ? "not enough samples" : `${Math.round(rate * 100)}%`;
}

export function EngineOpsScreen() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const queryClient = useQueryClient();
  const [requestChoice, setRequestChoice] = useState("");
  const [requestId, setRequestId] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // The metrics are read when the page opens. They cover the last seven days, as the server function's default says.
  const metrics = useQuery<StageMetricsReport>({
    queryKey: ["engine-ops", "metrics", organizationId],
    enabled: organizationId !== "",
    queryFn: () => getEngineStageMetrics({ data: { organizationId } }),
  });

  // The dead jobs are read only for the request the person typed, so nothing is listed without a choice.
  const deadJobs = useQuery<DeadJob[]>({
    queryKey: ["engine-ops", "dead-jobs", requestId],
    enabled: requestId !== "",
    queryFn: () => listEngineDeadJobs({ data: { requestId, limit: 200 } }),
  });

  const replay = useMutation({
    mutationFn: (jobId: string) => replayEngineDeadJob({ data: { requestId, jobId } }),
    onSuccess: (outcome) => {
      if (outcome.status === "refused") setMessage(`Not replayed: ${outcome.message}`);
      else if (outcome.status === "duplicate") setMessage("This job was already replayed. Nothing was sent again.");
      else setMessage(`Replayed. The request is now ${outcome.requestStatus}, with ${outcome.queued} job(s) queued.`);
      void queryClient.invalidateQueries({ queryKey: ["engine-ops", "dead-jobs", requestId] });
    },
  });

  if (!workspace?.active) return null;

  const report = metrics.data;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Engine operations"
        description="How the video engine has run in this workspace: request counts, the time each stage takes, how often each provider succeeds, and the jobs that stopped for good. Replaying a job can spend money, so only admins can do it."
      />

      <section aria-labelledby="metrics-heading" className="space-y-4">
        <h2 id="metrics-heading" className="text-section font-semibold">Last seven days</h2>
        {metrics.error ? <RefusalNotice error={metrics.error} /> : null}
        {report ? (
          <>
            <div className="grid gap-4 sm:grid-cols-5">
              <Card className="p-4"><p className="text-small text-fg-muted">Requests</p><p className="text-section font-semibold">{report.requests.total}</p></Card>
              <Card className="p-4"><p className="text-small text-fg-muted">Delivered</p><p className="text-section font-semibold">{report.requests.delivered}</p></Card>
              <Card className="p-4"><p className="text-small text-fg-muted">Running</p><p className="text-section font-semibold">{report.requests.running}</p></Card>
              <Card className="p-4"><p className="text-small text-fg-muted">Paused</p><p className="text-section font-semibold">{report.requests.paused}</p></Card>
              <Card className="p-4"><p className="text-small text-fg-muted">Rejected</p><p className="text-section font-semibold">{report.requests.rejected}</p></Card>
            </div>

            <Card className="overflow-x-auto p-4">
              <h3 className="mb-3 font-semibold">Time per stage</h3>
              {report.stages.length === 0 ? (
                <p className="text-small text-fg-muted">No stage has finished in this period.</p>
              ) : (
                <table className="w-full text-left text-small">
                  <thead><tr><th scope="col">Stage</th><th scope="col">Basis</th><th scope="col">Runs</th><th scope="col">Typical (p50)</th><th scope="col">Slow end (p95)</th></tr></thead>
                  <tbody>
                    {report.stages.map((stage) => (
                      <tr key={`${stage.stage}-${stage.basis}`}>
                        <td>{stage.stage}</td><td>{stage.basis}</td><td>{stage.count}</td><td>{seconds(stage.p50Ms)}</td><td>{seconds(stage.p95Ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="overflow-x-auto p-4">
              <h3 className="mb-3 font-semibold">Providers</h3>
              {report.providers.length === 0 ? (
                <p className="text-small text-fg-muted">No provider has been called in this period.</p>
              ) : (
                <table className="w-full text-left text-small">
                  <thead><tr><th scope="col">Provider</th><th scope="col">Attempts</th><th scope="col">Succeeded</th><th scope="col">Provider failures</th><th scope="col">Refused by the request</th><th scope="col">Success rate</th></tr></thead>
                  <tbody>
                    {report.providers.map((provider) => (
                      <tr key={provider.providerId}>
                        <td>{provider.providerId}</td><td>{provider.attempts}</td><td>{provider.successes}</td><td>{provider.providerFailures}</td><td>{provider.refused}</td><td>{percent(provider.successRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        ) : metrics.isPending ? (
          <p className="text-small text-fg-muted">Reading the metrics…</p>
        ) : null}
      </section>

      <section aria-labelledby="dead-heading" className="space-y-4">
        <h2 id="dead-heading" className="text-section font-semibold">Jobs that stopped for good</h2>
        <p className="text-small text-fg-muted">Paste a request ID to see its dead jobs. A request ID is shown on its content page.</p>
        <Field label="Request ID" hint="For example, the ID from the content page.">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setMessage(null);
              setRequestId(requestChoice.trim());
            }}
          >
            <input
              id="engine-request-id"
              className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-3 py-2"
              value={requestChoice}
              onChange={(event) => setRequestChoice(event.target.value)}
              autoComplete="off"
            />
            <Button type="submit" variant="secondary" size="md">Show dead jobs</Button>
          </form>
        </Field>

        {message ? <p role="status" className="text-small">{message}</p> : null}
        {requestId === "" ? null : deadJobs.error ? <RefusalNotice error={deadJobs.error} /> : deadJobs.data && deadJobs.data.length === 0 ? (
          <EmptyState title="No dead jobs" reason="This request has no job that stopped for good." />
        ) : deadJobs.data ? (
          <Card className="overflow-x-auto p-4">
            <table className="w-full text-left text-small">
              <thead><tr><th scope="col">Stage</th><th scope="col">Job</th><th scope="col">Attempts</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {deadJobs.data.map((job) => (
                  <tr key={job.jobId}>
                    <td>{job.stage ?? "unknown stage"}</td>
                    <td className="font-mono text-xs">{job.jobId}</td>
                    <td>{job.attempts} of {job.maxAttempts}</td>
                    <td>
                      {canAdmin ? (
                        <Button type="button" variant="secondary" size="md" loading={replay.isPending && replay.variables === job.jobId} onClick={() => replay.mutate(job.jobId)}>
                          Replay this job
                        </Button>
                      ) : (
                        <span className="text-fg-muted">Only an admin can replay a job.</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
