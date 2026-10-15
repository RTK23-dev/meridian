// Dead-letter listing (Video Engine Bible 5.1, 15.5). A job that exhausts its attempts is dead: its request pauses with its artifacts
// intact and the stage is recorded as a dead letter (jobs/orchestrator.ts, applyDead). This module lists those jobs per request, so an
// operator sees what failed, where, and with which error. It reads only; replay.ts does the re-queue.
//
// The error text of a dead job is what the worker stored. It can carry provider text, so it is data: it is shortened here and shown as
// text, never as markup (AGENTS.md rule 5).

import { z } from "zod";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";

export const DEAD_ERROR_MAX_CHARS = 500;

export type DeadJob = {
  jobId: string;
  requestId: string;
  /** The job type, for example engine.render, or engine.poll for a dead asynchronous status check. */
  jobType: string;
  /** The stage the job ran. Null when its payload does not parse: the job is still listed, never hidden. */
  stage: string | null;
  subjectId: string | null;
  attempt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  deadAt: string;
  /** True once the orchestrator has applied the dead event (dedupe key dead:<jobId>). */
  recorded: boolean;
  /** True once a replay of this job was applied (dedupe key replay:<jobId>). A replayed job stays dead on record. */
  replayed: boolean;
  /** True when the request is paused on this job's stage and subject right now. */
  pausedHere: boolean;
};

const payloadSchema = z.object({
  requestId: z.string().min(1),
  stage: z.string().min(1),
  subjectId: z.string().min(1),
  attempt: z.string().min(1),
});

/** The request id of an engine job's idempotency key (engine:<requestId>:<stage>:<subjectId>:<attempt>), or null for another key. */
export function requestIdOfKey(key: string): string | null {
  if (!key.startsWith("engine:")) return null;
  const requestId = key.split(":")[1];
  return requestId && requestId.length > 0 ? requestId : null;
}

/** Shortens a stored error to one line of at most DEAD_ERROR_MAX_CHARS. Empty text stays empty, meaning no recorded error. */
export function shortError(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DEAD_ERROR_MAX_CHARS ? `${flat.slice(0, DEAD_ERROR_MAX_CHARS)}...` : flat;
}

type DeadRow = {
  id: string;
  job_type: string;
  idempotency_key: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  last_error: string;
  updated_at: unknown;
  recorded: boolean;
  replayed: boolean;
};

/**
 * The dead engine jobs of one workspace, oldest first, optionally for one request. Tenancy: only the workspace's own jobs are read, and
 * the request's pause is read from its own row in that workspace.
 */
export async function listDeadJobs(sql: Sql, input: { organizationId: string; requestId?: string; limit?: number }): Promise<DeadJob[]> {
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("the dead-job list limit is a whole number from 1 to 1000");
  const rows =
    input.requestId === undefined
      ? await sql<DeadRow>`
          select j.id, j.job_type, j.idempotency_key, j.payload, j.attempts, j.max_attempts, j.last_error, j.updated_at,
            exists (select 1 from engine_events e where e.organization_id = j.organization_id and e.dedupe_key = 'dead:' || j.id) as recorded,
            exists (select 1 from engine_events e where e.organization_id = j.organization_id and e.dedupe_key = 'replay:' || j.id) as replayed
          from jobs j
          where j.organization_id = ${input.organizationId} and j.job_type like 'engine.%' and j.status = 'dead'
          order by j.updated_at asc, j.id asc
          limit ${limit}
        `
      : await sql<DeadRow>`
          select j.id, j.job_type, j.idempotency_key, j.payload, j.attempts, j.max_attempts, j.last_error, j.updated_at,
            exists (select 1 from engine_events e where e.organization_id = j.organization_id and e.dedupe_key = 'dead:' || j.id) as recorded,
            exists (select 1 from engine_events e where e.organization_id = j.organization_id and e.dedupe_key = 'replay:' || j.id) as replayed
          from jobs j
          where j.organization_id = ${input.organizationId} and j.job_type like 'engine.%' and j.status = 'dead'
            and left(j.idempotency_key, length(${`engine:${input.requestId}:`}::text)) = ${`engine:${input.requestId}:`}::text
          order by j.updated_at asc, j.id asc
          limit ${limit}
        `;

  const pausedOn = new Map<string, { stage: string; subjectId: string } | null>();
  const jobs: DeadJob[] = [];
  for (const row of rows) {
    const requestId = requestIdOfKey(row.idempotency_key);
    if (requestId === null) continue;
    const parsed = parsePayload(row.payload);
    if (!pausedOn.has(requestId)) pausedOn.set(requestId, await pauseOf(sql, input.organizationId, requestId));
    const pause = pausedOn.get(requestId) ?? null;
    jobs.push({
      jobId: row.id,
      requestId,
      jobType: row.job_type,
      stage: parsed?.stage ?? null,
      subjectId: parsed?.subjectId ?? null,
      attempt: parsed?.attempt ?? null,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: shortError(row.last_error),
      deadAt: new Date(row.updated_at as string | number | Date).toISOString(),
      recorded: row.recorded,
      replayed: row.replayed,
      pausedHere:
        pause !== null && parsed !== null && pause.stage === parsed.stage && pause.subjectId === parsed.subjectId,
    });
  }
  return jobs;
}

/** The stage and subject a request is paused on as a dead letter, or null when it is not paused on one. */
async function pauseOf(sql: Sql, organizationId: string, requestId: string): Promise<{ stage: string; subjectId: string } | null> {
  const request = await readEngineRequest(sql, organizationId, requestId);
  const pause = request?.state.pause;
  if (!request || !pause || pause.kind !== "dead_letter") return null;
  return { stage: pause.stage, subjectId: pause.subjectId };
}

function parsePayload(text: string): z.infer<typeof payloadSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
