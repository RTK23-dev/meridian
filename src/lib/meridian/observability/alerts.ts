export type AlertCode =
  | "worker.stopped"
  | "scheduler.stopped"
  | "queue.backlog"
  | "provider.failing"
  | "publishing.failed"
  | "performance.sync_failed"
  | "market.failed"
  | "dead_letter.growth"
  | "storage.failed";

/** Conditions a host can page on. This does not send the page. */
export function deriveAlerts(input: {
  worker: "running" | "stopped";
  scheduler: "running" | "stopped";
  queuedJobs: number;
  deadJobs: number;
  providerFailures: number;
  publishFailures: number;
  performanceFailures: number;
  marketFailures: number;
  storageFailed: boolean;
}): { code: AlertCode; detail: string }[] {
  const alerts: { code: AlertCode; detail: string }[] = [];
  if (input.worker === "stopped") alerts.push({ code: "worker.stopped", detail: "Worker heartbeat is stale or missing." });
  if (input.scheduler === "stopped") alerts.push({ code: "scheduler.stopped", detail: "Scheduler heartbeat is stale or missing." });
  if (input.queuedJobs > 100) alerts.push({ code: "queue.backlog", detail: `${input.queuedJobs} jobs are queued.` });
  if (input.deadJobs > 0) alerts.push({ code: "dead_letter.growth", detail: `${input.deadJobs} jobs are dead.` });
  if (input.providerFailures > 0) alerts.push({ code: "provider.failing", detail: `${input.providerFailures} provider probes failed.` });
  if (input.publishFailures > 0) alerts.push({ code: "publishing.failed", detail: `${input.publishFailures} publish steps failed.` });
  if (input.performanceFailures > 0) alerts.push({ code: "performance.sync_failed", detail: `${input.performanceFailures} performance syncs failed.` });
  if (input.marketFailures > 0) alerts.push({ code: "market.failed", detail: `${input.marketFailures} market collections failed.` });
  if (input.storageFailed) alerts.push({ code: "storage.failed", detail: "Object storage reported a failure." });
  return alerts;
}
