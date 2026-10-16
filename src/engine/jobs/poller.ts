// Asynchronous provider calls (Video Engine Bible 15.2, 5.1). A produce job submits to a provider, stores the external job
// reference on a poll job, and returns, which releases its lease. Each poll job checks once and either re-queues itself with a
// backoff, finishes the stage, or fails it when the provider failed or the stage timed out. No worker waits for minutes.

import { z } from "zod";
import { EngineError, type ProviderPoll } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { thresholds } from "../config/thresholds.ts";
import { ENGINE_POLL_JOB_TYPE, STAGE_SPECS, engineJobKey, priorityNumber } from "./registry.ts";
import { jobSettings } from "./settings.ts";
import { applyEngineEvent, transaction } from "./orchestrator-sql.ts";
import { enginePayloadSchema, withTimeout, type EnginePayload, type EngineRuntime, type StageContext, type StageOutput } from "./types.ts";
import { validateStageOutput } from "./validate.ts";

/** The payload of a poll job: the stage's own payload, plus the external job reference and the timing of the call. */
export const pollPayloadSchema = enginePayloadSchema.extend({
  provider: z.string().min(1),
  jobRef: z.string().min(1),
  submittedAt: z.iso.datetime(),
  timeoutMs: z.int().positive(),
  step: z.int().positive(),
  parentJobId: z.string().min(1).optional(),
  /** The handler's state for the call (the asset job of a generated take). Untrusted: the handler parses it again. */
  carry: z.unknown().optional(),
});
export type PollPayload = z.infer<typeof pollPayloadSchema>;

export type PollDecision =
  | { action: "wait"; runAfterMs: number; nextStep: number }
  | { action: "done" }
  /** refusal is set for a content or input refusal: the handler turns it into a hold, it is not retried (Bible 10.4). */
  | { action: "failed"; retryable: boolean; message: string; refusal: "content_policy" | "invalid_input" | null }
  | { action: "timed_out" };

/** Backoff before poll step n (1-based): initialMs, multiplied by factor each step, capped at maxMs (Bible 15.2). */
export function pollBackoffMs(step: number, policy: typeof jobSettings.poll = jobSettings.poll): number {
  if (!Number.isInteger(step) || step < 1) {
    throw new EngineError("invalid_input", "a poll step is a whole number from 1");
  }
  return Math.min(policy.maxMs, policy.initialMs * policy.factor ** (step - 1));
}

/**
 * What a poll step does with the provider's answer. Done beats timeout: a result that arrives just after the deadline is
 * still used. A wait never runs past the deadline, so the last poll lands on it.
 */
export function decidePoll(input: { step: number; submittedAtMs: number; nowMs: number; timeoutMs: number; status: ProviderPoll }): PollDecision {
  if (input.status.state === "done") return { action: "done" };
  if (input.status.state === "failed") {
    const kind = input.status.error?.kind;
    return {
      action: "failed",
      retryable: input.status.error?.retryable ?? false,
      message: input.status.error?.message ?? "the provider reported a failure without detail",
      refusal: kind === "content_policy" || kind === "invalid_input" ? kind : null,
    };
  }
  const elapsed = input.nowMs - input.submittedAtMs;
  if (elapsed >= input.timeoutMs) return { action: "timed_out" };
  const remaining = input.timeoutMs - elapsed;
  return { action: "wait", runAfterMs: Math.min(pollBackoffMs(input.step), remaining), nextStep: input.step + 1 };
}

async function requestBrand(sql: Sql, organizationId: string, requestId: string): Promise<string | null> {
  const rows = await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  if (!rows[0]) throw new EngineError("not_found", `request ${requestId} is not in this workspace`);
  return rows[0].brand_id;
}

function pollKey(payload: { requestId: string; subjectId: string; attempt: string }, step: number): string {
  return engineJobKey({ requestId: payload.requestId, stage: "poll", subjectId: payload.subjectId, attempt: `${payload.attempt}.${step}` });
}

/** Stores the external job reference and queues the first poll. The submitting job returns straight after this. */
export async function scheduleProviderPoll(
  sql: Sql,
  input: {
    payload: EnginePayload;
    provider: string;
    jobRef: string;
    submittedAt: string;
    parentJobId: string;
    /** The handler's state for the call, stored with the poll (JSON). */
    carry?: unknown;
  },
): Promise<string> {
  // The timeout of an asynchronous call is its stage's job timeout (Bible 5.1).
  const timeoutMs = STAGE_SPECS[input.payload.stage].timeoutMs;
  const first = jobSettings.poll.initialMs;
  return transaction(sql, async (tx) => {
    const brandId = await requestBrand(tx, input.payload.organizationId, input.payload.requestId);
    const payload: PollPayload = {
      ...input.payload,
      provider: input.provider,
      jobRef: input.jobRef,
      submittedAt: input.submittedAt,
      timeoutMs,
      step: 1,
      parentJobId: input.parentJobId,
      ...(input.carry === undefined ? {} : { carry: input.carry }),
    };
    const key = pollKey(payload, 1);
    const id = globalThis.crypto.randomUUID();
    await tx`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority, run_after)
      values (${id}, ${payload.organizationId}, ${brandId}, ${ENGINE_POLL_JOB_TYPE}, ${key}, 'queued', ${JSON.stringify(payload)},
        ${thresholds.jobs.maxAttempts}, ${input.parentJobId}, ${priorityNumber(payload.priority)},
        now() + (${first}::int * interval '1 millisecond'))
      on conflict (organization_id, idempotency_key) do nothing
    `;
    await tx`
      insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
      values (${globalThis.crypto.randomUUID()}, ${payload.organizationId}, ${payload.requestId}, 'submitted', ${payload.stage},
        ${payload.subjectId}, ${input.parentJobId}, ${`submit:${input.parentJobId}`},
        ${JSON.stringify({ provider: input.provider, jobRef: input.jobRef, attempt: payload.attempt })})
      on conflict (organization_id, dedupe_key) do nothing
    `;
    return key;
  });
}

async function queueNextPoll(sql: Sql, payload: PollPayload, nextStep: number, runAfterMs: number, currentJobId: string): Promise<void> {
  const next: PollPayload = { ...payload, step: nextStep, parentJobId: currentJobId };
  const brandId = await requestBrand(sql, payload.organizationId, payload.requestId);
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority, run_after)
    values (${globalThis.crypto.randomUUID()}, ${payload.organizationId}, ${brandId}, ${ENGINE_POLL_JOB_TYPE}, ${pollKey(payload, nextStep)},
      'queued', ${JSON.stringify(next)}, ${thresholds.jobs.maxAttempts}, ${currentJobId}, ${priorityNumber(payload.priority)},
      now() + (${Math.ceil(runAfterMs)}::int * interval '1 millisecond'))
    on conflict (organization_id, idempotency_key) do nothing
  `;
}

/**
 * Runs one poll step. The provider is asked once. A pending answer queues the next poll and returns (the lease is released).
 * A done answer finishes the stage through the handler's finish(). A refused answer (content_policy or invalid_input) also goes
 * to finish(), which turns it into the stage's hold (Bible 10.4). Any other failed or timed-out call throws a provider error, and
 * the job retries until it is dead, which the dispatcher records against the stage.
 */
export async function runPollJob(
  sql: Sql,
  input: { jobId: string; payload: PollPayload; runtime: EngineRuntime },
): Promise<string> {
  const { payload, runtime } = input;
  const stage = payload.stage;
  const adapter = runtime.providers.resolve(payload.provider, payload.organizationId);
  if (!adapter) {
    throw new EngineError("config", `provider ${payload.provider} is not resolvable in this runtime`, { stage, retryable: false });
  }
  const controller = new AbortController();
  const status = await withTimeout(adapter.poll(payload.jobRef), thresholds.jobs.leaseMs.claude, controller, `${payload.provider} status check`, stage);
  const decision = decidePoll({
    step: payload.step,
    submittedAtMs: Date.parse(payload.submittedAt),
    nowMs: runtime.now(),
    timeoutMs: payload.timeoutMs,
    status,
  });

  switch (decision.action) {
    case "wait":
      await queueNextPoll(sql, payload, decision.nextStep, decision.runAfterMs, input.jobId);
      return `pending:${stage}:${payload.step}`;
    // A failed call is settled, not retried here: the router reconciles its bill and moves to the next target if it has one
    // (assets/router.ts settle). The handler's finish turns the outcome into the stage's result or hold.
    case "failed":
      return finishPoll(sql, input, status, controller);
    case "timed_out": {
      // The deadline passed: cancel the provider job if the adapter can, then settle the call as a timeout failure (Bible 15.5).
      let note = "";
      if (adapter.cancel) {
        try {
          await adapter.cancel(payload.jobRef);
        } catch (error) {
          note = `; cancelling the provider job also failed: ${error instanceof Error ? error.message : "unknown error"}`;
        }
      }
      const timedOut: ProviderPoll = {
        state: "failed",
        error: { kind: "timeout", retryable: true, message: `${stage} did not finish within ${payload.timeoutMs} ms${note}` },
      };
      return finishPoll(sql, input, timedOut, controller);
    }
    case "done":
      return finishPoll(sql, input, status, controller);
  }
}

/** Hands a settled provider answer to the stage's finish step, then applies the stage output it returns. */
async function finishPoll(
  sql: Sql,
  input: { jobId: string; payload: PollPayload; runtime: EngineRuntime },
  status: ProviderPoll,
  controller: AbortController,
): Promise<string> {
  const { payload, runtime } = input;
  const stage = payload.stage;
  const handler = runtime.handlers[stage];
  if (!handler?.finish) {
    throw new EngineError("internal", `${stage} has no finish step for an asynchronous result, so the result was not stored`, { stage });
  }
  const context: StageContext = {
    sql,
    jobId: input.jobId,
    organizationId: payload.organizationId,
    requestId: payload.requestId,
    stage,
    subjectId: payload.subjectId,
    attempt: payload.attempt,
    payload: stripPollFields(payload),
    signal: controller.signal,
    poll: { provider: payload.provider, jobRef: payload.jobRef, submittedAt: payload.submittedAt, carry: payload.carry },
  };
  const result = await handler.finish(context, status);
  if (result.kind === "submitted") {
    // The call moved on to another target: its own poll is queued, and this stage's output waits for that poll.
    const key = await scheduleProviderPoll(sql, {
      payload: context.payload,
      provider: result.provider,
      jobRef: result.jobRef,
      submittedAt: result.submittedAt,
      parentJobId: input.jobId,
      ...(result.carry === undefined ? {} : { carry: result.carry }),
    });
    return `submitted:${stage}:${key}`;
  }
  const output: StageOutput = validateStageOutput(result.output, context.payload);
  const applied = await applyEngineEvent(sql, {
    organizationId: payload.organizationId,
    requestId: payload.requestId,
    event: { type: "succeeded", output },
    triggerJobId: input.jobId,
    dedupeKey: `poll:${input.jobId}`,
  });
  return applied.applied ? `completed:${stage}:${applied.queued}` : `duplicate:${stage}`;
}

function stripPollFields(payload: PollPayload): EnginePayload {
  return {
    organizationId: payload.organizationId,
    requestId: payload.requestId,
    stage: payload.stage,
    subjectId: payload.subjectId,
    attempt: payload.attempt,
    priority: payload.priority,
    budgetReservationId: payload.budgetReservationId,
    inputArtifactIds: payload.inputArtifactIds,
    hints: payload.hints,
    details: payload.details,
  };
}
