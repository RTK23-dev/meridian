// Replay of a dead-lettered stage (Video Engine Bible 5.2, 15.5). A dead job paused its request with the artifacts intact. A replay
// lifts that pause with the orchestrator's own `resume` event, so the stage is queued again from the request's current state: its
// inputs are the last good artifacts, because a dead job wrote none (Bible 5.2). The new job has the next attempt number, so its key is
// new and the dead one stays on record.
//
// Idempotent: the resume is applied under the dedupe key replay:<jobId>, so a second replay of the same dead job changes nothing and
// reports duplicate. Every call that is allowed writes an audit row (kind ops.replay, dedupe replay-audit:<jobId>), so a retry that
// finds the resume already applied still records who asked.
//
// Scope: this replays a dead-lettered stage only. Replay of a stage that succeeded (for debugging, Bible 15.5) needs a new orchestrator
// event that re-queues a completed stage; jobs/ is not edited here, so that is a request to the lead (STATUS.md).
//
// Authorization: the caller passes the actor's workspace role. Replay spends money (a stage that makes paid calls runs again), so it needs
// the admin role. A refusal is returned, never thrown, and a refused call writes nothing.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasRole, isRole, type Role } from "../../lib/meridian/access.ts";
import { EngineError } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { applyEngineEvent, readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { requestIdOfKey } from "./deadletter.ts";

/** The lowest workspace role that may replay a dead job. */
export const REPLAY_MINIMUM_ROLE: Role = "admin";

export type ReplayRefusal =
  | "not_authorized"
  | "not_found"
  | "unreadable_payload"
  | "not_dead"
  | "not_recorded"
  | "not_paused"
  | "not_the_paused_stage"
  | "resume_refused";

export type ReplayActor = { userId: string; role: string };

export type ReplayOutcome =
  | { status: "replayed"; jobId: string; requestId: string; stage: string; subjectId: string; requestStatus: string; queued: number }
  | { status: "duplicate"; jobId: string; requestId: string; stage: string; subjectId: string }
  | { status: "refused"; reason: ReplayRefusal; message: string };

const jobRowSchema = z.object({
  id: z.string().min(1),
  job_type: z.string().min(1),
  status: z.string().min(1),
  idempotency_key: z.string().min(1),
  payload: z.string(),
});

const payloadSchema = z.object({ requestId: z.string().min(1), stage: z.string().min(1), subjectId: z.string().min(1) });

function refused(reason: ReplayRefusal, message: string): ReplayOutcome {
  return { status: "refused", reason, message };
}

/**
 * Replays one dead engine job of one request in one workspace. The job must be dead, its dead event recorded, and the request paused on
 * that job's stage and subject. Anything else is refused with the reason named.
 */
export async function replayDeadJob(
  sql: Sql,
  input: { organizationId: string; requestId: string; jobId: string; actor: ReplayActor },
): Promise<ReplayOutcome> {
  const { organizationId, requestId, jobId, actor } = input;
  if (actor.userId.trim().length === 0 || !isRole(actor.role) || !hasRole(actor.role, REPLAY_MINIMUM_ROLE)) {
    return refused("not_authorized", `replaying a dead job needs the ${REPLAY_MINIMUM_ROLE} role`);
  }
  const rows = await sql<{ id: string; job_type: string; status: string; idempotency_key: string; payload: string }>`
    select id, job_type, status, idempotency_key, payload from jobs
    where id = ${jobId} and organization_id = ${organizationId} limit 1
  `;
  const parsedRow = jobRowSchema.safeParse(rows[0]);
  if (!parsedRow.success) return refused("not_found", "no such job in this workspace");
  const job = parsedRow.data;
  if (!job.job_type.startsWith("engine.") || requestIdOfKey(job.idempotency_key) !== requestId) {
    return refused("not_found", "the job does not belong to this request");
  }
  let payloadRaw: unknown;
  try {
    payloadRaw = JSON.parse(job.payload || "{}");
  } catch {
    return refused("unreadable_payload", "the job payload is not JSON, so its stage cannot be read");
  }
  const payload = payloadSchema.safeParse(payloadRaw);
  if (!payload.success || payload.data.requestId !== requestId) {
    return refused("unreadable_payload", "the job payload does not name its request, stage and subject");
  }
  const { stage, subjectId } = payload.data;

  // A replay already applied is a duplicate, whatever the request's state is now (it may be running again or paused elsewhere).
  const applied = await sql<{ id: string }>`
    select id from engine_events where organization_id = ${organizationId} and dedupe_key = ${`replay:${jobId}`} limit 1
  `;
  if (applied.length > 0) {
    await recordAudit(sql, { organizationId, requestId, jobId, stage, subjectId, actor });
    return { status: "duplicate", jobId, requestId, stage, subjectId };
  }

  if (job.status !== "dead") return refused("not_dead", `the job is ${job.status}, not dead, so there is nothing to replay`);
  const recorded = await sql<{ id: string }>`
    select id from engine_events where organization_id = ${organizationId} and dedupe_key = ${`dead:${jobId}`} limit 1
  `;
  if (recorded.length === 0) {
    return refused("not_recorded", "the dead job is not recorded on its request yet; the dead-job sweep records it first");
  }

  const request = await readEngineRequest(sql, organizationId, requestId);
  if (!request) return refused("not_found", "no such request in this workspace");
  if (request.status !== "paused") return refused("not_paused", `the request is ${request.status}, not paused`);
  const pause = request.state.pause;
  if (!pause || pause.kind !== "dead_letter" || pause.stage !== stage || pause.subjectId !== subjectId) {
    return refused("not_the_paused_stage", "the request is not paused on this job's stage and subject as a dead letter");
  }

  let outcome: { applied: boolean; status: string; queued: number };
  try {
    outcome = await applyEngineEvent(sql, {
      organizationId,
      requestId,
      event: { type: "resume" },
      dedupeKey: `replay:${jobId}`,
    });
  } catch (error) {
    if (error instanceof EngineError) return refused("resume_refused", error.message);
    throw error;
  }
  await recordAudit(sql, { organizationId, requestId, jobId, stage, subjectId, actor });
  if (!outcome.applied) return { status: "duplicate", jobId, requestId, stage, subjectId };
  return { status: "replayed", jobId, requestId, stage, subjectId, requestStatus: outcome.status, queued: outcome.queued };
}

/** Writes the audit row once per replayed job. The actor is the user id only, never an email or a key. */
async function recordAudit(
  sql: Sql,
  input: { organizationId: string; requestId: string; jobId: string; stage: string; subjectId: string; actor: ReplayActor },
): Promise<void> {
  await sql`
    insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
    values (${randomUUID()}, ${input.organizationId}, ${input.requestId}, 'ops.replay', ${input.stage}, ${input.subjectId},
      ${input.jobId}, ${`replay-audit:${input.jobId}`},
      ${JSON.stringify({ actorUserId: input.actor.userId, actorRole: input.actor.role, jobId: input.jobId, stage: input.stage, subjectId: input.subjectId })})
    on conflict (organization_id, dedupe_key) do nothing
  `;
}
