// The checks and reads behind the video engine operations server functions (actions.ts): stage metrics, the dead jobs of a request,
// and the replay of one dead job (Video Engine Bible 15.3, 5.2, 19 E6). Everything that decides who may see or change what is here, so
// the tests run it on PGlite without the server runtime.
//
// - Tenancy. A workspace read needs a membership in that workspace. A request is read in the workspace it belongs to, and the server
//   looks that workspace up from the request id: a client never names the workspace of a request. A caller who is not a member gets
//   the same refusal as for an unknown request, so a request id reveals nothing about other workspaces.
// - Roles (AGENTS.md rule 2). The metrics and the dead-job list need any member. Replay spends money (a stage that makes paid calls
//   runs again), so it needs the admin role. The role is the one the database holds for the caller, never one the client sends.
// - Refusals are thrown for the checks above. A replay the engine refuses (for example, a job that is not dead) is returned as a
//   refusal outcome, as replayDeadJob returns it, and nothing is written.

import { hasRole, isRole, type Role } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import { listDeadJobs, type DeadJob } from "../../../engine/ops/deadletter.ts";
import { readStageMetrics, type StageMetricsReport } from "../../../engine/ops/metrics-sql.ts";
import { REPLAY_MINIMUM_ROLE, replayDeadJob, type ReplayOutcome } from "../../../engine/ops/replay.ts";
import type { DeadJobsInput, ReplayInput, StageMetricsInput } from "./input.ts";

export const WORKSPACE_REFUSAL = "This workspace is not available to you.";
export const REQUEST_REFUSAL = "This request is not available to you.";

function roleRefusal(minimum: Role): string {
  return `This needs the ${minimum} role in this workspace.`;
}

/** The caller's role in a workspace, or a refusal when the caller is not a member or holds less than `minimum`. */
async function workspaceRole(sql: Sql, userId: string, organizationId: string, minimum: Role): Promise<Role> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new Error(WORKSPACE_REFUSAL);
  if (!hasRole(role, minimum)) throw new Error(roleRefusal(minimum));
  return role;
}

/**
 * The workspace of a request and the caller's role in it, read in one statement. A request the caller is not a member of, and a
 * request that does not exist, are refused with the same message.
 */
async function requestAccess(sql: Sql, userId: string, requestId: string, minimum: Role): Promise<{ organizationId: string; role: Role }> {
  const rows = await sql<{ organization_id: string; role: string | null }>`
    select r.organization_id, m.role
    from engine_requests r
    left join memberships m on m.organization_id = r.organization_id and m.user_id = ${userId}
    where r.id = ${requestId}
    limit 1
  `;
  const row = rows[0];
  const role = row?.role ?? null;
  if (!row || role === null || !isRole(role)) throw new Error(REQUEST_REFUSAL);
  if (!hasRole(role, minimum)) throw new Error(roleRefusal(minimum));
  return { organizationId: row.organization_id, role };
}

/** The stage metrics of one workspace since the input's start time. Any member may read them. */
export async function readWorkspaceStageMetrics(sql: Sql, userId: string, input: StageMetricsInput, now: Date = new Date()): Promise<StageMetricsReport> {
  await workspaceRole(sql, userId, input.organizationId, "viewer");
  return readStageMetrics(sql, { organizationIds: [input.organizationId] }, { now: () => now, since: input.since });
}

/** The dead engine jobs of one request, oldest first. Any member of the request's workspace may read them. */
export async function readRequestDeadJobs(sql: Sql, userId: string, input: DeadJobsInput): Promise<DeadJob[]> {
  const access = await requestAccess(sql, userId, input.requestId, "viewer");
  return listDeadJobs(sql, { organizationId: access.organizationId, requestId: input.requestId, limit: input.limit });
}

/**
 * Replays one dead job of one request. Only an admin of the request's workspace may replay it. The actor is the session's user and
 * the role the database holds for that user, so the engine's own admin check sees the same role the server checked.
 */
export async function replayRequestDeadJob(sql: Sql, userId: string, input: ReplayInput): Promise<ReplayOutcome> {
  const access = await requestAccess(sql, userId, input.requestId, REPLAY_MINIMUM_ROLE);
  return replayDeadJob(sql, {
    organizationId: access.organizationId,
    requestId: input.requestId,
    jobId: input.jobId,
    actor: { userId, role: access.role },
  });
}
