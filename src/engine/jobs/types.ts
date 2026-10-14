// Types shared by the orchestrator, dispatch and poller: the events the orchestrator reads, what a stage job returns,
// the payload a queued job carries, and the runtime a worker is given (Video Engine Bible 5.1 to 5.3, 15.2).

import { z } from "zod";
import type { ProviderAdapter, ProviderPoll, ModelClass, TakeVerdict, VisualType, GateResult } from "../contracts/index.ts";
import { EngineError, idSchema } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { ENGINE_STAGES, type EngineStage } from "./registry.ts";
import type { RequestPriority } from "./settings.ts";

/** Where a shot's source comes from (ShotSpec.source.kind). Generation and stock need a produce job; the others do not. */
export type ShotSourceKind = "generate" | "stock" | "component" | "asset";

/** What the plan stage reports about one shot. The orchestrator plans work from this, not from the plan body. */
export type ShotSummary = {
  shotId: string;
  visualType: VisualType;
  downgradeTo: VisualType | null;
  sourceKind: ShotSourceKind;
  modelClass: ModelClass | null;
  takesWanted: 1 | 2;
};

/** Every stage output names the subject it ran for and the artifacts it wrote, keyed by slot (for example "plan" or "take:<id>"). */
export type StageOutputBase = { subjectId: string; artifacts: Record<string, string> };

export type StageOutput =
  | (StageOutputBase & { stage: "intake"; gate: GateResult; budgetReservationId: string | null })
  | (StageOutputBase & { stage: "analyze_reference"; gate: GateResult })
  | (StageOutputBase & { stage: "voice"; gate: GateResult })
  | (StageOutputBase & { stage: "plan"; gate: GateResult; shots: ShotSummary[] })
  | (StageOutputBase & { stage: "estimate_reserve"; gate: GateResult; budgetReservationId: string | null })
  | (StageOutputBase & { stage: "produce_shot"; shotId: string; takeId: string })
  | (StageOutputBase & { stage: "check_take"; shotId: string; takeId: string; gate: GateResult; verdict: TakeVerdict })
  | (StageOutputBase & { stage: "edit"; gate: GateResult; edlId: string })
  | (StageOutputBase & { stage: "compose"; edlId: string })
  | (StageOutputBase & { stage: "pre_render_gate"; edlId: string; gate: GateResult })
  | (StageOutputBase & { stage: "render"; edlId: string; gate: GateResult })
  | (StageOutputBase & { stage: "post_render_review"; edlId: string; gate: GateResult })
  | (StageOutputBase & { stage: "variants"; variants: { edlId: string }[] })
  | (StageOutputBase & { stage: "deliver"; manifestId: string });

/**
 * The payload every engine job carries. inputArtifactIds are the only artifacts the job may read. hints are rule names from
 * failed checks (never free text from a model, Bible 1 trust boundaries). details holds stage-specific fields.
 */
export type EnginePayload = {
  organizationId: string;
  requestId: string;
  stage: EngineStage;
  subjectId: string;
  attempt: string;
  priority: RequestPriority;
  budgetReservationId: string | null;
  inputArtifactIds: string[];
  hints: string[];
  details: Record<string, unknown>;
};

export const enginePayloadSchema = z.object({
  organizationId: z.string().min(1),
  requestId: idSchema("req_"),
  stage: z.enum(ENGINE_STAGES),
  subjectId: z.string().min(1),
  attempt: z.string().min(1),
  priority: z.enum(["rush", "normal", "batch"]),
  budgetReservationId: z.string().min(1).nullable(),
  inputArtifactIds: z.array(z.string().min(1)),
  hints: z.array(z.string().min(1)),
  details: z.record(z.string(), z.unknown()),
});

/** A job the orchestrator wants queued. The SQL layer turns it into a row on Meridian's jobs table. */
export type QueuedJob = {
  stage: EngineStage;
  subjectId: string;
  attempt: string;
  key: string;
  priority: number;
  paid: boolean;
  maxAttempts: number;
  payload: EnginePayload;
};

/** Events the orchestrator reads. Job outcomes arrive as "succeeded" or "dead"; the rest come from people and the API. */
export type EngineEvent =
  | {
      type: "start";
      organizationId: string;
      requestId: string;
      priority: RequestPriority;
      cachedDna: boolean;
      /** Set when the format's VideoDNA is cached (Bible 6.1 step 5). Analysis is then skipped. */
      cachedDnaArtifactId?: string;
      variantCount: number;
      requestArtifactId: string;
    }
  | { type: "succeeded"; output: StageOutput }
  | { type: "dead"; stage: EngineStage; subjectId: string; reason: string }
  | { type: "resume" }
  | { type: "human_choice"; shotId: string; takeId: string };

export type StageContext = {
  sql: Sql;
  jobId: string;
  organizationId: string;
  requestId: string;
  stage: EngineStage;
  subjectId: string;
  attempt: string;
  payload: EnginePayload;
  /** Aborted when the stage's timeout (Bible 5.1) passes. A handler should stop its provider calls when it fires. */
  signal: AbortSignal;
};

/** A handler either finishes (done) or hands an asynchronous provider call to the poller (submitted, Bible 15.2). */
export type StageRunResult =
  | { kind: "done"; output: StageOutput }
  | { kind: "submitted"; provider: string; jobRef: string; submittedAt: string };

export type StageHandler = {
  run(ctx: StageContext): Promise<StageRunResult>;
  /** Turns a finished provider call into the stage's output (writes the Take, for example). Needed when run can submit. */
  finish?(ctx: StageContext, polled: ProviderPoll): Promise<StageOutput>;
};

export interface ProviderResolver {
  resolve(providerId: string): ProviderAdapter | null;
}

export type EngineRuntime = {
  handlers: Partial<Record<EngineStage, StageHandler>>;
  providers: ProviderResolver;
  now: () => number;
};

/**
 * Bible 17.2 rule 5 types errors by kind. eng-contracts has not yet added 'not_implemented' to ENGINE_ERROR_KINDS (see
 * STATUS.md), so the kind is set here. The error is still an EngineError with retryable false.
 */
export function notImplementedError(message: string, stage?: string): EngineError {
  const error = new EngineError("internal", message, { stage, retryable: false });
  error.kind = "not_implemented" as unknown as EngineError["kind"];
  return error;
}

/**
 * Races work against a timer (the job timeouts of Bible 5.1). On timeout the controller is aborted, so a handler that listens
 * to its signal can stop its provider call. The work itself cannot be forced to stop, and that is said in STATUS.md.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, controller: AbortController, label: string, stage?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EngineError("provider", `${label} did not finish within ${timeoutMs} ms`, { retryable: true, stage }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
