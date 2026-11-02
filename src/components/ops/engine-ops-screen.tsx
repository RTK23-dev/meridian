import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { getEngineAlerts, getEngineBatchReport, getEngineConcurrency, getEngineStageMetrics, listEngineDeadJobs, replayEngineDeadJob } from "@/lib/meridian/engine-ops/actions";
import type { BatchReport } from "@/engine/ops/batch.ts";
import type { ConcurrencyProposal } from "@/engine/ops/concurrency.ts";
import type { OpsAlert } from "@/engine/ops/alerts.ts";
import type { DeadJob } from "@/engine/ops/deadletter.ts";
import type { StageMetricsReport } from "@/engine/ops/metrics-sql.ts";
import { RefusalNotice } from "./ops-shared";

type AlertsReport = { thresholds: string; alerts: OpsAlert[] };
type ConcurrencyReport = { thresholds: string; callsInWindow: number; matchedCalls: number; proposals: ConcurrencyProposal[] };

const BUCKET_LABEL: Record<ConcurrencyProposal["bucket"], string> = { video: "Video", image: "Image", tts: "Speech" };

const CONCURRENCY_BASIS_LABEL: Record<ConcurrencyProposal["basis"], string> = {
  insufficient_data: "Held",
  held: "Held",
  rate_limited: "Smaller",
  headroom_measured: "Larger",
};

const ALERT_KIND_LABEL: Record<OpsAlert["kind"], string> = {
  budget_overrun: "Budget overrun",
  dead_letter_growth: "Dead letter",
  breaker_open: "Provider circuit open",
  stuck_request: "Stuck request",
  gate_pass_drop: "Gate pass rate dropped",
};

const ALERT_SEVERITY_LABEL: Record<OpsAlert["severity"], string> = {
  page: "Needs attention now",
  warn: "Look today",
};

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

  // The alerts are read when the page opens. They use the thresholds the engine proposes, and the page says so.
  const alerts = useQuery<AlertsReport>({
    queryKey: ["engine-ops", "alerts", organizationId],
    enabled: organizationId !== "",
    queryFn: () => getEngineAlerts({ data: { organizationId } }),
  });

  // The concurrency proposals are read when the page opens. They are shown only: nothing here changes a bucket's size.
  const concurrency = useQuery<ConcurrencyReport>({
    queryKey: ["engine-ops", "concurrency", organizationId],
    enabled: organizationId !== "",
    queryFn: () => getEngineConcurrency({ data: { organizationId } }),
  });

  // The batch requests are read when the page opens: how many asked for batch, and how the planner ran them.
  const batch = useQuery<BatchReport>({
    queryKey: ["engine-ops", "batch", organizationId],
    enabled: organizationId !== "",
    queryFn: () => getEngineBatchReport({ data: { organizationId } }),
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
        description="How the video engine has run in this workspace: request counts, the time each stage takes, how often each provider succeeds, and the engine's jobs that stopped for good. Meridian's own background jobs are on Jobs & health. Replaying an engine job can spend money, so only admins can do it."
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

      <section aria-labelledby="alerts-heading" className="space-y-4">
        <h2 id="alerts-heading" className="text-section font-semibold">Alerts right now</h2>
        <p className="text-small text-fg-muted">
          These use the thresholds the engine proposes{alerts.data ? ` (version ${alerts.data.thresholds})` : ""}. They have not been accepted yet,
          so read each one as a guide, not a verdict.
        </p>
        {alerts.error ? <RefusalNotice error={alerts.error} /> : null}
        {alerts.data && alerts.data.alerts.length === 0 ? (
          <EmptyState title="No alerts right now" reason="Nothing in this workspace is over a proposed limit." />
        ) : alerts.data ? (
          <Card className="overflow-x-auto p-4">
            <table className="w-full text-left text-small">
              <thead><tr><th scope="col">Severity</th><th scope="col">What</th><th scope="col">About</th><th scope="col">Why</th></tr></thead>
              <tbody>
                {alerts.data.alerts.map((alert, index) => (
                  <tr key={`${index}-${alert.kind}-${alert.subject}`}>
                    <td>{ALERT_SEVERITY_LABEL[alert.severity]}</td>
                    <td>{ALERT_KIND_LABEL[alert.kind]}</td>
                    <td className="font-mono text-xs">{alert.subject}</td>
                    <td>{alert.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : alerts.isPending ? (
          <p className="text-small text-fg-muted">Reading the alerts…</p>
        ) : null}
      </section>

      <section aria-labelledby="batch-heading" className="space-y-4">
        <h2 id="batch-heading" className="text-section font-semibold">Batch requests</h2>
        <p className="text-small text-fg-muted">
          A batch request asks for the batch price. Meridian runs it as normal calls unless the route&apos;s batch support is verified and its
          executor is built. The counts here come from the planner, so a batch is never counted unless the planner made one.
        </p>
        {batch.error ? <RefusalNotice error={batch.error} /> : null}
        {batch.data && batch.data.batchRequests === 0 ? (
          <EmptyState title="No batch requests" reason="No request in the last seven days asked for batch." />
        ) : batch.data ? (
          <Card className="space-y-2 p-4">
            <p>
              {batch.data.batchRequests} batch {batch.data.batchRequests === 1 ? "request" : "requests"} in the last seven days: {batch.data.asBatch} run
              as a batch, {batch.data.asNormalCalls} run as normal calls.
            </p>
            {batch.data.reason ? <p className="text-small text-fg-muted">The planner&apos;s reason: {batch.data.reason}.</p> : null}
          </Card>
        ) : batch.isPending ? (
          <p className="text-small text-fg-muted">Reading the batch requests…</p>
        ) : null}
      </section>

      <section aria-labelledby="concurrency-heading" className="space-y-4">
        <h2 id="concurrency-heading" className="text-section font-semibold">Concurrency proposals</h2>
        <p className="text-small text-fg-muted">
          These are proposals from the last hour of provider calls. Nothing here changes a bucket&apos;s size. A bucket grows only when the engine
          can measure how full it was.
        </p>
        {concurrency.error ? <RefusalNotice error={concurrency.error} /> : null}
        {concurrency.data ? (
          <Card className="space-y-3 overflow-x-auto p-4">
            <p>
              {concurrency.data.callsInWindow} provider {concurrency.data.callsInWindow === 1 ? "call" : "calls"} in the last hour,{" "}
              {concurrency.data.matchedCalls} matched to a bucket.
            </p>
            {concurrency.data.callsInWindow > 0 && concurrency.data.matchedCalls === 0 ? (
              <p className="text-small text-fg-muted">
                The engine does not record which bucket a provider call used, so no call can be matched, and every size is held.
              </p>
            ) : null}
            <table className="w-full text-left text-small">
              <thead><tr><th scope="col">Bucket</th><th scope="col">Size now</th><th scope="col">Proposed</th><th scope="col">Why</th></tr></thead>
              <tbody>
                {concurrency.data.proposals.map((proposal) => (
                  <tr key={proposal.bucket}>
                    <td>{BUCKET_LABEL[proposal.bucket]}</td>
                    <td>{proposal.current}</td>
                    <td>{proposal.proposed}</td>
                    <td>{CONCURRENCY_BASIS_LABEL[proposal.basis]}: {proposal.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : concurrency.isPending ? (
          <p className="text-small text-fg-muted">Reading the proposals…</p>
        ) : null}
      </section>

      <section aria-labelledby="dead-heading" className="space-y-4">
        <h2 id="dead-heading" className="text-section font-semibold">Jobs that stopped for good</h2>
        <p className="text-small text-fg-muted">Paste a request ID to see its dead jobs. A request ID is shown on its content page.</p>
        <Field id="engine-request-id" label="Request ID" hint="For example, the ID from the content page.">
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
