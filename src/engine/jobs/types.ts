// Types shared by the orchestrator, dispatch and poller: the events the orchestrator reads, what a stage job returns,
// the payload a queued job carries, and the runtime a worker is given (Video Engine Bible 5.1 to 5.3, 15.2).

import { z } from "zod";
import type { Decision, ProviderAdapter, ProviderPoll, ModelClass, TakeVerdict, VisualType, GateResult } from "../contracts/index.ts";
import { EngineError, idSchema } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { ENGINE_STAGES, type EngineMaintenanceJob, type EngineStage } from "./registry.ts";
import type { RequestPriority } from "./settings.ts";
import type { GoldMetrics } from "../review/gold.ts";
import type { VariantWorkItem } from "../variants/work.ts";
import type { WriterText } from "../variants/writer.ts";

/**
 * Where a shot's source comes from (ShotSpec.source.kind). Generation, stock and a chain of calls (contract v5) need a produce job;
 * the others do not.
 */
export type ShotSourceKind = "generate" | "stock" | "component" | "asset" | "chain";

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

/**
 * Why a produce job made no take. A budget hold pauses the request with the reason (Bible 14). A refusal (content_policy or
 * invalid_input, Bible 10.4) goes back to the planner once for a rewrite; the hint is a rule-style name written by this code,
 * never provider text.
 */
export type ProduceHold = { kind: "budget"; reason: string } | { kind: "refused"; errorKind: "content_policy" | "invalid_input"; hint: string };

export type StageOutput =
  /**
   * budgetReservationId is the pre-flight hold, set on a pass. budgetPause is set when the hold was paused or refused (or the
   * workspace month is not connected): the request pauses on budget with that reason, and a resume runs intake again (Bible 14).
   */
  | (StageOutputBase & { stage: "intake"; gate: GateResult; budgetReservationId: string | null; budgetPause: string | null })
  | (StageOutputBase & { stage: "analyze_reference"; gate: GateResult })
  /**
   * The script written from a brief (contract v8). It has no gate: its checks are the role's answer contract and the stage's minimum,
   * and a failure fails the stage with its reason. Its artifacts name the written script (slot "script") when it passes.
   */
  | (StageOutputBase & { stage: "write_script" })
  | (StageOutputBase & { stage: "voice"; gate: GateResult })
  | (StageOutputBase & { stage: "plan"; gate: GateResult; shots: ShotSummary[] })
  | (StageOutputBase & { stage: "estimate_reserve"; gate: GateResult; budgetReservationId: string | null })
  /**
   * takeId is set when the take was made, and hold is set when it was not (never both). epoch is the plan epoch of the shot the job
   * was queued for: a replan starts a new epoch, and a result from an older one is recorded but never counted (Bible 5.3).
   */
  | (StageOutputBase & { stage: "produce_shot"; shotId: string; takeId: string | null; epoch: number; hold?: ProduceHold; decisions?: Decision[] })
  | (StageOutputBase & { stage: "check_take"; shotId: string; takeId: string; gate: GateResult; verdict: TakeVerdict })
  | (StageOutputBase & { stage: "edit"; gate: GateResult; edlId: string })
  | (StageOutputBase & { stage: "compose"; edlId: string })
  | (StageOutputBase & { stage: "pre_render_gate"; edlId: string; gate: GateResult })
  /** decisions is set when the renderer was a fallback (Bible 6.11, L7): the manifest records why the video was rendered that way. */
  | (StageOutputBase & { stage: "render"; edlId: string; gate: GateResult; decisions?: Decision[] })
  | (StageOutputBase & { stage: "post_render_review"; edlId: string; gate: GateResult })
  /**
   * The variants stage in phases (Bible 6.13). The request phase funds the generation variants, writes the caption and music EDLs and
   * hands over the work list of each generation variant (`work`). Each later phase is one job of one variant, whose subject is the
   * variant's subject (VariantWorkItem.subject): its writer call, its voice, then its plan. A phase that cannot finish is not_built with
   * the reason, and that variant alone fails.
   */
  | (StageOutputBase & { stage: "variants"; phase: "request"; variants: { edlId: string }[]; work: VariantWorkItem[] })
  | (StageOutputBase & { stage: "variants"; phase: "writer"; key: string; outcome: VariantWriterOutcome })
  | (StageOutputBase & { stage: "variants"; phase: "voice"; key: string; outcome: VariantVoiceOutcome })
  | (StageOutputBase & { stage: "variants"; phase: "plan"; key: string; outcome: VariantPlanOutcome })
  /**
   * The variant's assembly: its EDL, built over its own inputs (variants/assemble.ts). gate is the edit gate of that build, with the checks
   * that ran. edlId is set whether or not the build passed (the gate names it). A passing build writes the edl artifact (edl:<edlId>).
   */
  | (StageOutputBase & { stage: "variants"; phase: "assemble"; key: string; edlId: string; gate: GateResult; outcome: VariantAssemblyOutcome })
  | (StageOutputBase & { stage: "deliver"; manifestId: string });

/** A variant's writer call, done (with the text it wrote) or not built (with the reason). */
export type VariantWriterOutcome = { status: "done"; text: WriterText } | { status: "not_built"; reason: string };
/** A variant's voice, done (with its track's id and artifact) or not built. */
export type VariantVoiceOutcome = { status: "done"; voiceTrackId: string; artifacts: Record<string, string> } | { status: "not_built"; reason: string };
/** A variant's assembly: built (its EDL is stored) or not built (the edit gate failed, or an input was not usable). */
export type VariantAssemblyOutcome = { status: "done" } | { status: "not_built"; reason: string };
/** A variant's plan, done (with its artifact and the shots to produce, in the plan's own terms) or not built. */
export type VariantPlanOutcome = { status: "done"; artifacts: Record<string, string>; produce: ShotSummary[] } | { status: "not_built"; reason: string };

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
      /** The request sends a brief, so write_script writes its script (contract v8). Absent or false: a script request, which skips it. */
      brief?: boolean;
      variantCount: number;
      requestArtifactId: string;
      /** The gold metrics the request's gates are judged by (Bible 12.4). Absent: no check is proven, so every failure is reviewed. */
      gateMetrics?: Record<string, GoldMetrics>;
    }
  | { type: "succeeded"; output: StageOutput }
  /** epoch is the plan epoch of a produce job (from its payload), so a dead job of an older plan does not pause the request. */
  | { type: "dead"; stage: EngineStage; subjectId: string; reason: string; epoch?: number }
  | { type: "resume" }
  | { type: "human_choice"; shotId: string; takeId: string }
  /**
   * A person asked for one accepted shot of a delivered video to be made again (Bible 5.5). `at` is the time the caller recorded, so
   * replaying the event gives the same state. `budgetReservationId` is the reservation the caller made for this remake: the request's
   * own reservation was released at delivery.
   */
  | {
      type: "remake";
      shotId: string;
      directive: string | null;
      budgetReservationId: string;
      at: string;
      /** The plan artifact written with the shot replaced (D7), or null when the plan is kept. */
      planArtifactId?: string | null;
      /** The shot's new summary when the remake replaces the shot's visual type or source (D7). Null keeps the shot as it was. */
      replacement?: ShotSummary | null;
    };

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
  /** Set on a finish step only: the asynchronous provider call that was submitted and is now settled (Bible 15.2). */
  poll?: { provider: string; jobRef: string; submittedAt: string; carry?: unknown };
};

/** The plan epoch a produce or check job was queued for (Bible 5.3), when its payload names one. */
export function epochOf(payload: EnginePayload): number | undefined {
  const epoch = payload.details.epoch;
  return typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? epoch : undefined;
}

/** A handler either finishes (done) or hands an asynchronous provider call to the poller (submitted, Bible 15.2). */
export type StageRunResult =
  | { kind: "done"; output: StageOutput }
  /** carry is the handler's own state for the poll (the asset job, for a generated take). It is stored as JSON and parsed again. */
  | { kind: "submitted"; provider: string; jobRef: string; submittedAt: string; carry?: unknown };

export type StageHandler = {
  run(ctx: StageContext): Promise<StageRunResult>;
  /**
   * Turns a settled provider call into the stage's output (writes the Take, for example). It receives the provider's answer,
   * which is done, failed (a refusal included) or timed out is never passed here: a failed or timed-out call throws in the poller.
   * A refused answer (content_policy, invalid_input) is passed with state "failed" and becomes the stage's hold.
   * Needed when run can submit.
   */
  /**
   * Settles the provider call once it is finished. It returns the stage's result, or submitted again when the call moved on to
   * another target: the poller then schedules the next poll with the new carry, and nothing is written yet.
   */
  finish?(ctx: StageContext, polled: ProviderPoll): Promise<StageRunResult>;
};

export interface ProviderResolver {
  /** The adapter that polls a submitted call of this provider, for one workspace (its credentials are the workspace's). */
  resolve(providerId: string, organizationId: string): ProviderAdapter | null;
}

/**
 * A maintenance job's handler (contract v9). It is not a stage: it has no request and writes no artifact. It runs on the workspace of its
 * job, and returns the result string Meridian stores.
 */
export type EngineJobHandler = {
  run(ctx: { sql: Sql; organizationId: string; jobId: string }): Promise<string>;
};

export type EngineRuntime = {
  handlers: Partial<Record<EngineStage, StageHandler>>;
  providers: ProviderResolver;
  now: () => number;
  /** The maintenance jobs built for this runtime (registry.ts ENGINE_MAINTENANCE_JOBS). Absent, a maintenance job is not implemented. */
  jobs?: Partial<Record<EngineMaintenanceJob, EngineJobHandler>>;
};

/** Bible 17.2 rule 5 types errors by kind. A stage with no handler is refused as not_implemented, never retried. */
export function notImplementedError(message: string, stage?: string): EngineError {
  return new EngineError("not_implemented", message, { stage, retryable: false });
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
