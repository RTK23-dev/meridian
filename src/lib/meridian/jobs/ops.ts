/**
 * Pure helpers for the jobs and health server functions. No database access here, so each rule can be tested directly.
 * Status values match the jobs_status_check constraint (migrations 0004 and 0006).
 */
import { redactSecrets } from "../observability/redact.ts";
import { isoTimestamp } from "../observability/timestamps.ts";

export const JOB_STATUSES = ["queued", "running", "retry", "succeeded", "dead", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_PAGE_SIZE = 50;
/** Same 30-second rule as /api/health and getSystemStatus. */
export const HEARTBEAT_FRESH_MS = 30_000;
const PAYLOAD_FIELD_LIMIT = 50;
const ERROR_LIMIT = 500;
const RESULT_LIMIT = 2_000;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|password|passwd|secret|token|authorization)(["']?\s*[:=]\s*["']?)[^\s,;&"']+/gi;

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

/** Text from a job row (an executor error or result), with secrets removed and clipped. */
export function jobText(value: unknown, limit = ERROR_LIMIT): string {
  const raw = value == null ? "" : String(value);
  return redactSecrets(raw).replace(SECRET_ASSIGNMENT, "$1$2redacted").slice(0, limit);
}

export type HeartbeatState = { state: "running" | "stopped"; ageSeconds: number | null };

/** A heartbeat is alive when it is less than 30 seconds old. A missing or unreadable beat is stopped, never running. */
export function heartbeatState(beatAt: unknown, now: number): HeartbeatState {
  const time = beatAt instanceof Date ? beatAt.getTime() : Date.parse(String(beatAt ?? ""));
  if (!Number.isFinite(time)) return { state: "stopped", ageSeconds: null };
  const age = now - time;
  return { state: age < HEARTBEAT_FRESH_MS ? "running" : "stopped", ageSeconds: Math.max(0, Math.round(age / 1000)) };
}

/** Status counts from `group by status`. Counts may arrive as strings from the driver. */
export function countsByStatus(rows: readonly { status: string; count: unknown }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

/** Queued and retrying jobs are waiting for the worker. Same definition as the alerts and the jobs screen. */
export function queueDepth(counts: Record<string, number>): number {
  return (counts.queued ?? 0) + (counts.retry ?? 0);
}

/**
 * Only dead jobs can be retried. No job row has a "failed" status: a failing attempt becomes "retry" until attempts run
 * out, and then "dead".
 */
export function canRetryJob(status: string): boolean {
  return status === "dead";
}

/** Only queued jobs can be cancelled. The worker sweeps cancel_requested rows that are queued or retrying into "cancelled". */
export function canCancelJob(status: string, cancelRequested: boolean): boolean {
  return status === "queued" && !cancelRequested;
}

export type PayloadField = { name: string; kind: "string" | "number" | "boolean" | "null" | "array" | "object" };

/**
 * Field names and value types only. Values are never returned: payloads can hold webhook URLs and tokens
 * (alert.deliver stores a target URL). A payload that is not a JSON object has no fields.
 */
export function payloadFields(raw: unknown): PayloadField[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed)
    .slice(0, PAYLOAD_FIELD_LIMIT)
    .map(([name, value]) => ({ name: name.slice(0, 80), kind: kindOf(value) }));
}

function kindOf(value: unknown): PayloadField["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

export function normalizePage(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(0, Math.min(value, 100_000)) : 0;
}

function boundedText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

export type JobListFilters = { organizationId: string; status: JobStatus | ""; type: string; brandId: string; page: number };

export function jobListFilters(input: unknown): JobListFilters {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const organizationId = boundedText(value.organizationId, 100, "Workspace");
  if (!organizationId) throw new Error("Choose a workspace.");
  const status = boundedText(value.status, 20, "Status");
  if (status && !isJobStatus(status)) throw new Error("Choose a valid job status.");
  return {
    organizationId,
    status: status as JobStatus | "",
    type: boundedText(value.type, 80, "Job type"),
    brandId: boundedText(value.brandId, 100, "Brand"),
    page: normalizePage(value.page),
  };
}

/** Input for a single job: the workspace and the job id. */
export function jobRefInput(input: unknown): { organizationId: string; jobId: string } {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const organizationId = boundedText(value.organizationId, 100, "Workspace");
  if (!organizationId) throw new Error("Choose a workspace.");
  const jobId = boundedText(value.jobId, 100, "Job");
  if (!jobId) throw new Error("Choose a job.");
  return { organizationId, jobId };
}

/** Input for an operation scoped to one workspace only. */
export function workspaceInput(input: unknown): { organizationId: string } {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const organizationId = boundedText(value.organizationId, 100, "Workspace");
  if (!organizationId) throw new Error("Choose a workspace.");
  return { organizationId };
}

export type JobView = {
  id: string;
  brandId: string | null;
  brandName: string;
  jobType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string;
  payloadKeys: string[];
  createdAt: string;
  updatedAt: string;
  runAfter: string;
  cancelRequested: boolean;
  /**
   * Always null for now. The jobs table has no run start or finish time, so a duration cannot be measured
   * without changing the executor. It is not estimated from created_at or updated_at.
   */
  durationMs: null;
  canRetry: boolean;
  canCancel: boolean;
};

export function jobView(row: Record<string, unknown>): JobView {
  const status = String(row.status ?? "");
  const cancelRequested = row.cancel_requested === true || row.cancel_requested === "t";
  return {
    id: String(row.id),
    brandId: row.brand_id == null ? null : String(row.brand_id),
    brandName: String(row.brand_name ?? "") || "Workspace job",
    jobType: String(row.job_type ?? ""),
    status,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    error: jobText(row.last_error),
    payloadKeys: payloadFields(row.payload).map((field) => field.name),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    runAfter: isoTimestamp(row.run_after),
    cancelRequested,
    durationMs: null,
    canRetry: canRetryJob(status),
    canCancel: canCancelJob(status, cancelRequested),
  };
}

export type JobDetailView = JobView & {
  payloadFields: PayloadField[];
  result: string;
  dependsOn: string;
  priority: number;
  leaseUntil: string;
  heartbeatAt: string;
};

export function jobDetailView(row: Record<string, unknown>): JobDetailView {
  return {
    ...jobView(row),
    payloadFields: payloadFields(row.payload),
    result: jobText(row.result, RESULT_LIMIT),
    dependsOn: String(row.depends_on ?? ""),
    priority: row.priority == null ? 0 : Number(row.priority),
    leaseUntil: isoTimestamp(row.lease_until),
    heartbeatAt: isoTimestamp(row.heartbeat_at),
  };
}

export type WorkerHealthView = {
  checkedAt: string;
  worker: HeartbeatState;
  scheduler: HeartbeatState;
  queue: { queued: number; retry: number; running: number; depth: number };
  deadLetter: number;
};

/**
 * Health cards for one workspace. Heartbeats are process-wide (the worker serves every workspace); job counts are only
 * this workspace's rows.
 */
export function workerHealthView(input: {
  beats: readonly { name: string; beat_at: unknown }[];
  counts: Record<string, number>;
  now: number;
}): WorkerHealthView {
  const beat = (name: string) => heartbeatState(input.beats.find((row) => row.name === name)?.beat_at, input.now);
  return {
    checkedAt: new Date(input.now).toISOString(),
    worker: beat("worker"),
    scheduler: beat("scheduler"),
    queue: {
      queued: input.counts.queued ?? 0,
      retry: input.counts.retry ?? 0,
      running: input.counts.running ?? 0,
      depth: queueDepth(input.counts),
    },
    deadLetter: input.counts.dead ?? 0,
  };
}
