// Runs one engine job on Meridian's queue (Video Engine Bible 5.1, 5.3, 15.2 and 15.5). Meridian's worker calls
// executeEngineJob for every job whose type starts with "engine.". The handler for the stage is injected through the runtime.
// A stage without a handler is refused with a not_implemented error: it is never recorded as a success.

import { EngineError } from "../contracts/index.ts";
import type { ExecutableJob } from "../../lib/meridian/jobs/execute.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { applyEngineEvent } from "./orchestrator-sql.ts";
import { ENGINE_POLL_JOB_TYPE, STAGE_SPECS, stageFromJobType, type EngineStage } from "./registry.ts";
import { pollPayloadSchema, runPollJob, scheduleProviderPoll, type PollPayload } from "./poller.ts";
import { validateStageOutput } from "./validate.ts";
import { enginePayloadSchema, epochOf, notImplementedError, withTimeout, type EnginePayload, type EngineRuntime, type StageContext } from "./types.ts";

/** The runtime used by the worker. Handlers are added with registerStageHandler; until then every stage is not_implemented. */
export const engineRuntime: EngineRuntime = {
  handlers: {},
  providers: { resolve: () => null },
  now: () => Date.now(),
};

/** Adds the handler for one stage to a runtime (the worker's by default). Wave-by-wave stages register here. */
export function registerStageHandler(stage: EngineStage, handler: NonNullable<EngineRuntime["handlers"][EngineStage]>, runtime: EngineRuntime = engineRuntime): void {
  runtime.handlers[stage] = handler;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "the engine job failed";
}

function parsePayload(job: ExecutableJob): { base: EnginePayload; poll: PollPayload | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(job.payload || "{}");
  } catch (error) {
    throw new EngineError("invalid_input", `${job.job_type} ${job.id} has a payload that is not JSON`, { cause: error });
  }
  const isPoll = job.job_type === ENGINE_POLL_JOB_TYPE;
  const parsed = isPoll ? pollPayloadSchema.safeParse(raw) : enginePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError("invalid_input", `${job.job_type} ${job.id} has an invalid payload: ${issue ? issue.path.join(".") : "unknown"}`);
  }
  if (parsed.data.organizationId !== job.organization_id) {
    throw new EngineError("invalid_input", `${job.job_type} ${job.id} names another workspace (tenant scope violation)`);
  }
  if (isPoll) {
    const poll = parsed.data as PollPayload;
    return { base: poll, poll };
  }
  return { base: parsed.data as EnginePayload, poll: null };
}

/**
 * Runs one claimed engine job and returns the result string Meridian stores. A stage result is applied to the request with its
 * dedupe key, so a retried job cannot advance the graph twice. On the last attempt a failure is recorded as a dead letter
 * against the stage, which pauses the request with its artifacts intact (Bible 15.5). The error is then rethrown, so Meridian
 * marks the job dead.
 */
export async function executeEngineJob(sql: Sql, job: ExecutableJob, runtime: EngineRuntime = engineRuntime): Promise<string> {
  const { base, poll } = parsePayload(job);
  const finalAttempt = job.attempts + 1 >= job.max_attempts;
  try {
    return await run(sql, job, base, poll, runtime);
  } catch (error) {
    if (finalAttempt) {
      await recordDeadLetter(sql, job, base, error);
    }
    throw error;
  }
}

async function run(sql: Sql, job: ExecutableJob, base: EnginePayload, poll: PollPayload | null, runtime: EngineRuntime): Promise<string> {
  if (poll) return runPollJob(sql, { jobId: job.id, payload: poll, runtime });

  const stage = stageFromJobType(job.job_type);
  if (stage !== base.stage) {
    throw new EngineError("invalid_input", `${job.job_type} carries a payload for ${base.stage}`, { stage });
  }
  const spec = STAGE_SPECS[stage];
  if (spec.paid && base.budgetReservationId === null) {
    throw new EngineError("invalid_input", `${stage} is a paid stage and has no budget reservation, so nothing was called (Bible 14)`, { stage });
  }
  const handler = runtime.handlers[stage];
  if (!handler) {
    throw notImplementedError(`${job.job_type} has no handler registered, so the job did not run and was not marked done`, stage);
  }

  const controller = new AbortController();
  const context: StageContext = {
    sql,
    jobId: job.id,
    organizationId: base.organizationId,
    requestId: base.requestId,
    stage,
    subjectId: base.subjectId,
    attempt: base.attempt,
    payload: base,
    signal: controller.signal,
  };
  const result = await withTimeout(handler.run(context), spec.timeoutMs, controller, `${job.job_type} (${spec.timeoutMs} ms limit)`, stage);

  if (result.kind === "submitted") {
    const key = await scheduleProviderPoll(sql, {
      payload: base,
      provider: result.provider,
      jobRef: result.jobRef,
      submittedAt: result.submittedAt,
      parentJobId: job.id,
      ...(result.carry === undefined ? {} : { carry: result.carry }),
    });
    return `submitted:${stage}:${key}`;
  }

  const output = validateStageOutput(result.output, base);
  const applied = await applyEngineEvent(sql, {
    organizationId: base.organizationId,
    requestId: base.requestId,
    event: { type: "succeeded", output },
    triggerJobId: job.id,
    dedupeKey: `job:${job.id}`,
  });
  return applied.applied ? `advanced:${stage}:${applied.queued}` : `duplicate:${stage}`;
}

async function recordDeadLetter(sql: Sql, job: ExecutableJob, base: EnginePayload, cause: unknown): Promise<void> {
  const epoch = epochOf(base);
  try {
    await applyEngineEvent(sql, {
      organizationId: base.organizationId,
      requestId: base.requestId,
      event: { type: "dead", stage: base.stage, subjectId: base.subjectId, reason: messageOf(cause), ...(epoch === undefined ? {} : { epoch }) },
      dedupeKey: `dead:${job.id}`,
    });
  } catch (recordError) {
    throw new EngineError("internal", `${messageOf(cause)}; recording the dead letter also failed: ${messageOf(recordError)}`, {
      cause,
      stage: base.stage,
    });
  }
}
