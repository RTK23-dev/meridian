/**
 * The health response. The public answer is liveness only: the application answered, and nothing else is said. Counts and
 * operational state are returned only to a signed-in workspace admin, and only for that workspace. Nothing in a response
 * is summed across workspaces.
 *
 * The route in routes/api/health.ts supplies the session, the membership lookup and the database. This module decides
 * what may be returned, so the signed-out case can be tested without the auth stack.
 */
import { hasRole, isRole } from "../access.ts";
import type { Sql } from "../learning/store.ts";

/** The heartbeat is fresh for this long. Older beats are reported as stopped. */
export const HEARTBEAT_FRESH_MS = 30_000;

export type HeartbeatState = "running" | "stopped" | "not_reported" | "unknown";

export type HealthDetail = {
  database: "up" | "down";
  worker: HeartbeatState;
  scheduler: HeartbeatState;
  /** Job counts by status for the caller's workspace only. Null when they could not be read. */
  jobs: Array<{ status: string; count: number }> | null;
  /** Publishing queue counts by status for the caller's workspace only. Null when they could not be read. */
  publishingQueue: Array<{ status: string; count: number }> | null;
};

export type HealthResult = { status: number; body: Record<string, unknown> };

export type HealthDeps = {
  /** The signed-in user id, or null when nobody is signed in. */
  resolveUserId: () => Promise<string | null>;
  /** The caller's active workspace and role in it, or null when the caller has none. */
  resolveActiveWorkspace: (userId: string) => Promise<{ organizationId: string; role: string } | null>;
  /** The detail for one workspace. Called only for a workspace admin. */
  loadDetail: (organizationId: string) => Promise<Record<string, unknown>>;
};

/** The only body a signed-out or non-admin caller gets. It has no counts. */
export const PUBLIC_HEALTH_BODY = { status: "ok" } as const;

/**
 * Answers one health request. A plain request gets liveness and touches nothing else. A detail request needs a signed-in
 * workspace admin. Signed-out callers and non-admins get no detail, and the loader is not called.
 */
export async function healthResult(detailRequested: boolean, deps: HealthDeps): Promise<HealthResult> {
  if (!detailRequested) return { status: 200, body: { ...PUBLIC_HEALTH_BODY } };
  const userId = await deps.resolveUserId();
  if (!userId) return { status: 401, body: { error: "Unauthorized" } };
  const active = await deps.resolveActiveWorkspace(userId);
  if (!active || !isRole(active.role) || !hasRole(active.role, "admin")) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  const detail = await deps.loadDetail(active.organizationId);
  return { status: 200, body: { ...PUBLIC_HEALTH_BODY, ...detail } };
}

/**
 * The state of one heartbeat row. A missing row is "not_reported", not "stopped": nothing has said it was running. A row
 * whose time cannot be read is "unknown".
 */
export function heartbeatState(row: { beat_at: unknown } | undefined, now: number): HeartbeatState {
  if (!row) return "not_reported";
  if (row.beat_at === null || row.beat_at === undefined) return "unknown";
  const time = Date.parse(String(row.beat_at));
  if (!Number.isFinite(time)) return "unknown";
  return now - time < HEARTBEAT_FRESH_MS ? "running" : "stopped";
}

/**
 * The database-backed part of the detail for one workspace. When the database cannot be read, every value that depends on
 * it is "unknown" or null, never a count of zero.
 */
export async function loadHealthDetail(sql: Sql, organizationId: string, now: number = Date.now()): Promise<HealthDetail> {
  try {
    await sql`select 1 as ok`;
  } catch {
    return { database: "down", worker: "unknown", scheduler: "unknown", jobs: null, publishingQueue: null };
  }

  const detail: HealthDetail = { database: "up", worker: "unknown", scheduler: "unknown", jobs: null, publishingQueue: null };

  try {
    const beats = await sql<{ name: string; beat_at: string }>`
      select name, beat_at from process_heartbeats where name in ('worker', 'scheduler')
    `;
    detail.worker = heartbeatState(beats.find((beat) => beat.name === "worker"), now);
    detail.scheduler = heartbeatState(beats.find((beat) => beat.name === "scheduler"), now);
  } catch {
    detail.worker = "unknown";
    detail.scheduler = "unknown";
  }

  try {
    detail.jobs = await sql<{ status: string; count: number }>`
      select status, count(*)::int as count from jobs where organization_id = ${organizationId} group by status
    `;
  } catch {
    detail.jobs = null;
  }

  try {
    detail.publishingQueue = await sql<{ status: string; count: number }>`
      select status, count(*)::int as count from publishing_queues where organization_id = ${organizationId} group by status
    `;
  } catch {
    detail.publishingQueue = null;
  }

  return detail;
}
