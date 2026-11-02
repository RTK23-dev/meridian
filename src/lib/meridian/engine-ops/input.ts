// Input checks for the video engine operations server functions (Video Engine Bible 15.3, 5.2, 19 E6). Plain code with no server
// imports, so the validators can travel with the server functions the way jobs/ops.ts does. Each check keeps only the fields it names:
// a workspace named in a request body is never a way to reach another workspace's data (see service.ts).

/** The window of the stage metrics when the caller gives no start time: the last seven days (STATUS.md: a full read is not for the API). */
export const METRICS_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The most dead jobs one list returns. The default matches the operations read (deadletter.ts). */
export const DEAD_JOB_LIST_DEFAULT = 200;
export const DEAD_JOB_LIST_MAX = 1000;

const ENGINE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type StageMetricsInput = { organizationId: string; since: string };
export type DeadJobsInput = { requestId: string; limit: number };
export type ReplayInput = { requestId: string; jobId: string };
export type AlertsInput = { organizationId: string };

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function engineId(value: unknown, label: string): string {
  const id = text(value);
  if (!ENGINE_ID.test(id)) throw new Error(`Choose a valid ${label}.`);
  return id;
}

/** A workspace (organization) id, checked the way the other server functions check it. */
function workspaceId(value: unknown): string {
  const id = text(value);
  if (!id || id.length > 100) throw new Error("Choose a workspace.");
  return id;
}

/** The alerts of one workspace. Only the workspace id is kept; any other field is dropped. */
export function alertsInput(input: unknown): AlertsInput {
  return { organizationId: workspaceId(fields(input).organizationId) };
}

/** The stage metrics of one workspace. A missing start time means the last seven days, measured from `now`. */
export function stageMetricsInput(input: unknown, now: Date = new Date()): StageMetricsInput {
  const value = fields(input);
  const organizationId = workspaceId(value.organizationId);
  const sinceText = text(value.since);
  if (sinceText === "") return { organizationId, since: new Date(now.getTime() - METRICS_DEFAULT_WINDOW_MS).toISOString() };
  const sinceMs = Date.parse(sinceText);
  if (!Number.isFinite(sinceMs)) throw new Error("Choose a valid start time.");
  return { organizationId, since: new Date(sinceMs).toISOString() };
}

/** The dead jobs of one request. The limit is a whole number from 1 to 1000; a missing limit is the default. */
export function deadJobsInput(input: unknown): DeadJobsInput {
  const value = fields(input);
  const requestId = engineId(value.requestId, "request");
  if (value.limit === undefined || value.limit === null) return { requestId, limit: DEAD_JOB_LIST_DEFAULT };
  if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > DEAD_JOB_LIST_MAX) {
    throw new Error(`Choose a limit from 1 to ${DEAD_JOB_LIST_MAX}.`);
  }
  return { requestId, limit: value.limit };
}

/** One dead job of one request. Any other field is dropped, the workspace included (it comes from the request). */
export function replayInput(input: unknown): ReplayInput {
  const value = fields(input);
  return { requestId: engineId(value.requestId, "request"), jobId: engineId(value.jobId, "job") };
}
