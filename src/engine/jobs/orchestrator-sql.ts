// The orchestrator's SQL layer (Video Engine Bible 5.1, 5.3, 5.4). It reads a request's state under a row lock, applies one
// event with the pure advance(), writes the effects and the state, and inserts the jobs that became ready into Meridian's
// `jobs` table. Each event is recorded once under a dedupe key, so a retried job cannot advance the graph twice.

import { randomUUID } from "node:crypto";
import { EngineError } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { advance, ORCHESTRATOR_STATE_SCHEMA, type EngineEffect, type OrchestratorState } from "./orchestrator.ts";
import { isEngineStage, type EngineStage } from "./registry.ts";
import type { RequestPriority } from "./settings.ts";
import type { EngineEvent, QueuedJob } from "./types.ts";

/** Runs fn in one transaction, or refuses. A connection without transactions never runs a half-applied event. */
export async function transaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!sql.begin) {
    throw new EngineError("internal", "this database connection cannot run a transaction, so the engine event was not applied");
  }
  return sql.begin(fn);
}

export type RequestStatus = OrchestratorState["status"];

export type StartRequestInput = {
  organizationId: string;
  brandId: string | null;
  requestId: string;
  formatId: string;
  priority: RequestPriority;
  cachedDna: boolean;
  cachedDnaArtifactId?: string;
  variantCount: number;
  requestArtifactId: string;
};

/** Creates the request row and queues intake. Refused if the request id already exists. */
export async function startEngineRequest(sql: Sql, input: StartRequestInput): Promise<{ status: RequestStatus; queued: number }> {
  return transaction(sql, async (tx) => {
    const existing = await tx<{ id: string }>`
      select id from engine_requests where id = ${input.requestId} and organization_id = ${input.organizationId} limit 1
    `;
    if (existing.length > 0) throw new EngineError("conflict", `request ${input.requestId} already exists`);
    const started = advance(null, {
      type: "start",
      organizationId: input.organizationId,
      requestId: input.requestId,
      priority: input.priority,
      cachedDna: input.cachedDna,
      ...(input.cachedDnaArtifactId ? { cachedDnaArtifactId: input.cachedDnaArtifactId } : {}),
      variantCount: input.variantCount,
      requestArtifactId: input.requestArtifactId,
    });
    await tx`
      insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, current_stage, state)
      values (${input.requestId}, ${input.organizationId}, ${input.brandId}, ${input.formatId}, ${input.priority},
        ${started.state.status}, ${started.jobs.at(-1)?.stage ?? ""}, ${JSON.stringify(started.state)})
    `;
    await queueJobs(tx, input.brandId, started.jobs, null);
    await recordEvent(tx, { organizationId: input.organizationId, requestId: input.requestId, kind: "start", stage: "", subjectId: input.requestId, jobId: "", dedupeKey: null, body: { queued: started.jobs.length } });
    return { status: started.state.status, queued: started.jobs.length };
  });
}

export type ApplyInput = {
  organizationId: string;
  requestId: string;
  event: EngineEvent;
  /** The job whose completion caused this event. Jobs it queues depend on it (Meridian's depends_on). */
  triggerJobId?: string;
  /** Applies the event once: a second call with the same key changes nothing. */
  dedupeKey?: string;
};

export type ApplyResult = { applied: boolean; status: RequestStatus; queued: number };

/** Applies one event under a row lock and writes what it produced, all in one transaction. */
export async function applyEngineEvent(sql: Sql, input: ApplyInput): Promise<ApplyResult> {
  return transaction(sql, async (tx) => {
    const rows = await tx<{ state: string; status: RequestStatus; brand_id: string | null }>`
      select state, status, brand_id from engine_requests
      where id = ${input.requestId} and organization_id = ${input.organizationId}
      for update
    `;
    const row = rows[0];
    if (!row) throw new EngineError("not_found", `request ${input.requestId} is not in this workspace`);

    const eventInfo = describeEvent(input.event);
    const inserted = await tx<{ id: string }>`
      insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
      values (${randomUUID()}, ${input.organizationId}, ${input.requestId}, ${eventInfo.kind}, ${eventInfo.stage},
        ${eventInfo.subjectId}, ${input.triggerJobId ?? ""}, ${input.dedupeKey ?? null}, ${JSON.stringify(eventInfo.body)})
      on conflict (organization_id, dedupe_key) do nothing
      returning id
    `;
    if (inserted.length === 0) return { applied: false, status: row.status, queued: 0 };

    const current = parseState(row.state, input.requestId, input.organizationId);
    const result = advance(current, input.event);
    await writeEffects(tx, input.organizationId, input.requestId, result.effects);
    await queueJobs(tx, row.brand_id, result.jobs, input.triggerJobId ?? null);
    await tx`
      update engine_requests
      set state = ${JSON.stringify(result.state)}, status = ${result.state.status},
        current_stage = ${result.jobs.at(-1)?.stage ?? ""},
        budget_reservation_id = ${result.state.budgetReservationId},
        pause_reason = ${result.state.pause?.reason ?? ""}, updated_at = now()
      where id = ${input.requestId} and organization_id = ${input.organizationId}
    `;
    return { applied: true, status: result.state.status, queued: result.jobs.length };
  });
}

function describeEvent(event: EngineEvent): { kind: string; stage: string; subjectId: string; body: Record<string, unknown> } {
  switch (event.type) {
    case "start":
      return { kind: "start", stage: "", subjectId: event.requestId, body: {} };
    case "succeeded":
      return { kind: "stage.succeeded", stage: event.output.stage, subjectId: event.output.subjectId, body: { artifacts: event.output.artifacts } };
    case "dead":
      return { kind: "stage.dead", stage: event.stage, subjectId: event.subjectId, body: { reason: event.reason } };
    case "resume":
      return { kind: "resume", stage: "", subjectId: "", body: {} };
    case "human_choice":
      return { kind: "human_choice", stage: "check_take", subjectId: event.shotId, body: { takeId: event.takeId } };
  }
}

function parseState(text: string, requestId: string, organizationId: string): OrchestratorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new EngineError("internal", `the stored state of ${requestId} is not JSON`, { cause: error });
  }
  const state = parsed as Partial<OrchestratorState> | null;
  if (!state || state.schema !== ORCHESTRATOR_STATE_SCHEMA || state.requestId !== requestId || state.organizationId !== organizationId) {
    throw new EngineError("internal", `the stored state of ${requestId} does not match this request`);
  }
  return state as OrchestratorState;
}

async function writeEffects(tx: Sql, organizationId: string, requestId: string, effects: EngineEffect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.kind) {
      case "gate":
        await tx`
          insert into engine_gate_results (id, organization_id, request_id, gate, subject_id, passed, checks, failing_shot_ids)
          values (${randomUUID()}, ${organizationId}, ${requestId}, ${effect.gate.gate}, ${effect.gate.subjectId}, ${effect.gate.pass},
            ${JSON.stringify(effect.gate.checks)}, ${JSON.stringify(effect.gate.failingShotIds ?? [])})
        `;
        break;
      case "decision":
        await tx`
          insert into engine_decisions (id, organization_id, request_id, at, chose, alternatives, reason, decided_by)
          values (${randomUUID()}, ${organizationId}, ${requestId}, ${effect.decision.at}, ${effect.decision.chose},
            ${JSON.stringify(effect.decision.alternatives)}, ${effect.decision.reason}, ${effect.decision.by})
        `;
        break;
      case "review_item":
        await tx`
          insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail)
          values (${randomUUID()}, ${organizationId}, ${requestId}, ${effect.reviewKind}, 'open', ${effect.subjectId},
            ${effect.reason}, ${JSON.stringify(effect.detail)})
        `;
        break;
      case "gold_label":
        await recordEvent(tx, {
          organizationId,
          requestId,
          kind: "gold_label",
          stage: "check_take",
          subjectId: effect.shotId,
          jobId: "",
          dedupeKey: null,
          body: { takeId: effect.takeId, chosenBy: "human" },
        });
        break;
      case "rejected":
      case "delivered":
        // The request row carries the status. Nothing else to write.
        break;
    }
  }
}

async function recordEvent(
  tx: Sql,
  input: { organizationId: string; requestId: string; kind: string; stage: string; subjectId: string; jobId: string; dedupeKey: string | null; body: Record<string, unknown> },
): Promise<void> {
  await tx`
    insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
    values (${randomUUID()}, ${input.organizationId}, ${input.requestId}, ${input.kind}, ${input.stage}, ${input.subjectId},
      ${input.jobId}, ${input.dedupeKey}, ${JSON.stringify(input.body)})
    on conflict (organization_id, dedupe_key) do nothing
  `;
}

/**
 * Inserts the ready jobs on Meridian's jobs table. The idempotency key (organization, key) makes a repeat insert a no-op.
 * A paid job without a reservation was already refused by advance(); this is the last check before a row exists.
 */
async function queueJobs(tx: Sql, brandId: string | null, jobs: QueuedJob[], triggerJobId: string | null): Promise<void> {
  for (const job of jobs) {
    if (job.paid && job.payload.budgetReservationId === null) {
      throw new EngineError("invalid_input", `${job.stage} is paid and has no budget reservation, so it is not queued`, { stage: job.stage });
    }
    await tx`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority)
      values (${randomUUID()}, ${job.payload.organizationId}, ${brandId}, ${`engine.${job.stage}`}, ${job.key}, 'queued',
        ${JSON.stringify(job.payload)}, ${job.maxAttempts}, ${triggerJobId ?? ""}, ${job.priority})
      on conflict (organization_id, idempotency_key) do nothing
    `;
  }
}

export type DeadJobOutcome = { jobId: string; outcome: "applied" | "duplicate" | "refused"; message: string };

/**
 * Records engine jobs that Meridian marked dead without calling the engine (for example a lease that expired after the last
 * attempt). Each is applied once, under its dedupe key. A refusal is reported, not hidden.
 */
export async function recordDeadEngineJobs(sql: Sql, limit = 50): Promise<DeadJobOutcome[]> {
  // A job already recorded under its dedupe key (by the dispatcher or an earlier sweep) is not listed again.
  const rows = await sql<{ id: string; organization_id: string; payload: string; last_error: string }>`
    select j.id, j.organization_id, j.payload, j.last_error from jobs j
    where j.job_type like 'engine.%' and j.status = 'dead'
      and not exists (
        select 1 from engine_events e
        where e.organization_id = j.organization_id and e.dedupe_key = 'dead:' || j.id
      )
    order by j.updated_at asc, j.id asc
    limit ${limit}
  `;
  const outcomes: DeadJobOutcome[] = [];
  for (const row of rows) {
    const payload = parseDeadPayload(row.payload);
    if (!payload) {
      outcomes.push({ jobId: row.id, outcome: "refused", message: "the job payload has no request, stage and subject" });
      continue;
    }
    try {
      const applied = await applyEngineEvent(sql, {
        organizationId: row.organization_id,
        requestId: payload.requestId,
        event: {
        type: "dead",
        stage: payload.stage,
        subjectId: payload.subjectId,
        reason: row.last_error || "the job is dead",
        ...(payload.epoch === undefined ? {} : { epoch: payload.epoch }),
      },
        dedupeKey: `dead:${row.id}`,
      });
      outcomes.push({ jobId: row.id, outcome: applied.applied ? "applied" : "duplicate", message: applied.status });
    } catch (error) {
      outcomes.push({ jobId: row.id, outcome: "refused", message: error instanceof Error ? error.message : "refused" });
    }
  }
  return outcomes;
}

function parseDeadPayload(text: string): { requestId: string; stage: EngineStage; subjectId: string; epoch?: number } | null {
  try {
    const parsed = JSON.parse(text || "{}") as { requestId?: unknown; stage?: unknown; subjectId?: unknown; details?: { epoch?: unknown } };
    if (typeof parsed.requestId !== "string" || typeof parsed.subjectId !== "string" || typeof parsed.stage !== "string") return null;
    if (!isEngineStage(parsed.stage)) return null;
    const epoch = parsed.details?.epoch;
    return {
      requestId: parsed.requestId,
      stage: parsed.stage,
      subjectId: parsed.subjectId,
      ...(typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? { epoch } : {}),
    };
  } catch {
    return null;
  }
}

/** Reads a request's status and state for an API or a test. Tenancy: only the request's own workspace can read it. */
export async function readEngineRequest(sql: Sql, organizationId: string, requestId: string): Promise<{ status: RequestStatus; state: OrchestratorState; currentStage: string } | null> {
  const rows = await sql<{ state: string; status: RequestStatus; current_stage: string }>`
    select state, status, current_stage from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { status: row.status, state: parseState(row.state, requestId, organizationId), currentStage: row.current_stage };
}
