/**
 * Pure rules for the jobs and health screen. No React and no server imports, so each rule can be tested directly.
 * The server decides what a job can do (canRetry, canCancel) and whether a heartbeat is current (the 30-second rule).
 * This file only turns those answers into words and keeps unknown values unknown.
 */

export type JobFilters = { status: string; type: string; brandId: string; page: number };
export const EMPTY_JOB_FILTERS: JobFilters = { status: "", type: "", brandId: "", page: 0 };

export const JOB_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "retry", label: "Retrying" },
  { value: "succeeded", label: "Succeeded" },
  { value: "dead", label: "Dead letter" },
  { value: "cancelled", label: "Cancelled" },
];

/** Jobs waiting for the worker (queued, retrying) or running now. The list and the health cards refresh while one is shown. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "retry"]);

export function isActiveJobStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function hasActiveJob(jobs: readonly { status: string }[]): boolean {
  return jobs.some((job) => isActiveJobStatus(job.status));
}

export type HeartbeatState = { state: "running" | "stopped"; ageSeconds: number | null };
export type HealthCopy = { value: string; detail: string; healthy: boolean };

/** A whole number of seconds, minutes, hours or days, for "Last heartbeat 12 s ago". */
export function formatAge(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3_600) return `${Math.floor(whole / 60)} min`;
  if (whole < 86_400) return `${Math.floor(whole / 3_600)} h`;
  return `${Math.floor(whole / 86_400)} d`;
}

/**
 * Running or stopped, as the server judged it with the 30-second rule. A stopped process with no recorded beat says so,
 * rather than showing an age of zero.
 */
export function heartbeatCopy(beat: HeartbeatState): HealthCopy {
  if (beat.state === "running") {
    return {
      value: "Running",
      healthy: true,
      detail: beat.ageSeconds == null ? "A heartbeat arrived within the last 30 seconds." : `Last heartbeat ${formatAge(beat.ageSeconds)} ago.`,
    };
  }
  if (beat.ageSeconds == null) return { value: "Stopped", healthy: false, detail: "No heartbeat has been recorded." };
  return {
    value: "Stopped",
    healthy: false,
    detail: `Last heartbeat ${formatAge(beat.ageSeconds)} ago. A heartbeat counts as current for 30 seconds.`,
  };
}

export function queueCopy(queue: { queued: number; retry: number; running: number }): string {
  return `${queue.queued} queued · ${queue.retry} retrying · ${queue.running} running`;
}

export function deadLetterCopy(count: number): string {
  return count === 0 ? "No dead jobs." : "Dead jobs stay stopped until an admin retries each one.";
}

/** The server does not measure job duration yet, so every job reads "Unknown". A duration is never estimated. */
export function durationLabel(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return "Unknown";
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

export function attemptsLabel(attempts: number, maxAttempts: number): string {
  return `${attempts} of ${maxAttempts > 0 ? maxAttempts : "unknown"}`;
}

export { pageSpan, timestampLabel } from "./format";

/**
 * Which row actions show. The server flags say whether the job is in a state that allows the action. Admin is the screen's
 * own gate, and the server checks it again on every call.
 */
export function jobActionState(
  job: { canRetry: boolean; canCancel: boolean; cancelRequested: boolean },
  canAdmin: boolean,
): { retry: boolean; cancel: boolean; cancelNote: string | null } {
  return {
    retry: canAdmin && job.canRetry,
    cancel: canAdmin && job.canCancel,
    cancelNote: job.cancelRequested ? "Cancellation requested. The worker stops it on its next pass." : null,
  };
}

const PAYLOAD_KIND_LABELS: Record<string, string> = {
  string: "text",
  number: "number",
  boolean: "true or false",
  null: "empty",
  array: "list",
  object: "object",
};

/** Field names and value types only, from the server. Values are never shown. */
export function payloadLines(fields: readonly { name: string; kind: string }[]): string[] {
  return fields.map((field) => `${field.name} (${PAYLOAD_KIND_LABELS[field.kind] ?? "value"})`);
}

export function shortJobId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
