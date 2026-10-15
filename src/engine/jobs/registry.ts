// Engine job types on Meridian's queue (Video Engine Bible 3, 5.1 and 5.3). Each of the 14 stages is one `engine.<stage>`
// job type. Timeouts, attempts and redo limits come from engine/config; priority numbers come from ./settings.ts.

import type { ArtifactType, GateId } from "../contracts/index.ts";
import { EngineError } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { jobSettings, type RequestPriority } from "./settings.ts";

export const ENGINE_STAGES = [
  "intake",
  "analyze_reference",
  "voice",
  "plan",
  "estimate_reserve",
  "produce_shot",
  "check_take",
  "edit",
  "compose",
  "pre_render_gate",
  "render",
  "post_render_review",
  "variants",
  "deliver",
] as const;

export type EngineStage = (typeof ENGINE_STAGES)[number];
export type EngineJobType = `engine.${EngineStage}`;

/** Infrastructure job that polls an asynchronous provider call (Bible 15.2). It is not one of the 14 stages. */
export const ENGINE_POLL_JOB_TYPE = "engine.poll" as const;

/** Bible 5.1 lease classes: 2 minutes for Claude calls, 10 minutes for generation, 5 minutes for render. */
export type TimeoutClass = "claude" | "generation" | "render";

export type StageSpec = {
  stage: EngineStage;
  jobType: EngineJobType;
  /** Bible 3 group: 1 intake, 2 analysis, 3 planning, 4 shots, 5 edit, 6 compose and render, 7 review, 8 variants and deliver. */
  group: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  timeoutClass: TimeoutClass;
  timeoutMs: number;
  /** A paid call. It may be queued only with a budget reservation on the request (Bible 14). */
  paid: boolean;
  maxAttempts: number;
  /** Artifact types the job reads. It must not read anything else (Bible 5.1). */
  reads: ArtifactType[];
  /** Artifact types the job writes: one per run (Bible 3). */
  writes: ArtifactType[];
  gate: GateId | null;
};

const timeoutMsByClass: Record<TimeoutClass, number> = {
  claude: thresholds.jobs.leaseMs.claude,
  generation: thresholds.jobs.leaseMs.generation,
  render: thresholds.jobs.leaseMs.render,
};

type Row = Omit<StageSpec, "jobType" | "timeoutMs" | "maxAttempts"> & {
  /**
   * The lease of this stage is its timeout class times this factor. The plan makes three Claude calls (classification, planner
   * and director, each with its own HTTP timeout) under one lease, so it gets three Claude leases (lead decision, E3). A
   * thresholds.jobs.leaseMs.plan entry should replace the factor when the config owner adds it.
   */
  timeoutFactor?: number;
};

const rows: Record<EngineStage, Row> = {
  // intake is not paid in this table: it reserves its own pre-flight hold first, and every paid call it makes is on that hold
  // (handlers/intake.ts). The dispatcher therefore never refuses it for want of a reservation.
  intake: { stage: "intake", group: 1, timeoutClass: "claude", paid: false, reads: ["production_request"], writes: ["validated_request"], gate: "request" },
  analyze_reference: { stage: "analyze_reference", group: 2, timeoutClass: "claude", paid: true, reads: ["production_request"], writes: ["video_dna"], gate: "dna" },
  voice: { stage: "voice", group: 2, timeoutClass: "generation", paid: true, reads: ["production_request"], writes: ["voice_track"], gate: "voice" },
  plan: { stage: "plan", group: 3, timeoutClass: "claude", timeoutFactor: 3, paid: true, reads: ["validated_request", "video_dna", "voice_track"], writes: ["scene_plan"], gate: "plan" },
  estimate_reserve: { stage: "estimate_reserve", group: 3, timeoutClass: "claude", paid: false, reads: ["scene_plan", "production_request"], writes: ["budget_reservation"], gate: "budget" },
  produce_shot: { stage: "produce_shot", group: 4, timeoutClass: "generation", paid: true, reads: ["scene_plan"], writes: ["take"], gate: null },
  check_take: { stage: "check_take", group: 4, timeoutClass: "claude", paid: true, reads: ["take", "scene_plan"], writes: ["take_verdict"], gate: "take" },
  edit: { stage: "edit", group: 5, timeoutClass: "claude", paid: false, reads: ["scene_plan", "take", "voice_track", "video_dna", "validated_request"], writes: ["edl"], gate: "edit" },
  compose: { stage: "compose", group: 6, timeoutClass: "claude", paid: false, reads: ["edl", "validated_request"], writes: ["composition"], gate: null },
  // The pre-render gate reads every input its checks need: the plan and the DNA (the grammar), the voice, the validated request
  // (the kit references and the script), and the accepted takes (Bible 6.10, review/STATUS.md decision 6).
  pre_render_gate: {
    stage: "pre_render_gate",
    group: 6,
    timeoutClass: "claude",
    paid: false,
    reads: ["composition", "edl", "scene_plan", "validated_request", "voice_track", "video_dna", "take"],
    writes: ["gate_result"],
    gate: "pre_render",
  },
  // The render stores its integrity gate result (a gate_result) next to the rendered video (Bible 6.11).
  render: { stage: "render", group: 6, timeoutClass: "render", paid: true, reads: ["composition", "edl", "validated_request"], writes: ["rendered_video", "gate_result"], gate: "render_integrity" },
  post_render_review: {
    stage: "post_render_review",
    group: 7,
    timeoutClass: "claude",
    paid: true,
    reads: ["rendered_video", "edl", "gate_result"],
    writes: ["review_result"],
    gate: "post_render",
  },
  // The variants stage expands the request's matrix against the request and its plan (Bible 6.13).
  variants: { stage: "variants", group: 8, timeoutClass: "claude", paid: true, reads: ["production_request", "scene_plan", "edl"], writes: ["edl"], gate: null },
  deliver: { stage: "deliver", group: 8, timeoutClass: "claude", paid: false, reads: [], writes: ["manifest"], gate: null },
};

function specOf(row: Row): StageSpec {
  const { timeoutFactor = 1, ...spec } = row;
  return {
    ...spec,
    jobType: `engine.${row.stage}`,
    timeoutMs: timeoutMsByClass[row.timeoutClass] * timeoutFactor,
    maxAttempts: thresholds.jobs.maxAttempts,
  };
}

export const STAGE_SPECS: Readonly<Record<EngineStage, StageSpec>> = Object.freeze(
  Object.fromEntries(ENGINE_STAGES.map((stage) => [stage, specOf(rows[stage])])) as Record<EngineStage, StageSpec>,
);

/** The 14 stage job types, in pipeline order. */
export const ENGINE_JOB_TYPES: readonly EngineJobType[] = ENGINE_STAGES.map((stage) => STAGE_SPECS[stage].jobType);

export function isEngineStage(value: string): value is EngineStage {
  return (ENGINE_STAGES as readonly string[]).includes(value);
}

/** The stage a job type runs. An unknown type is refused, never run as something else. */
export function stageFromJobType(jobType: string): EngineStage {
  if (!jobType.startsWith("engine.")) {
    throw new EngineError("invalid_input", `${jobType} is not an engine job type`);
  }
  const stage = jobType.slice("engine.".length);
  if (!isEngineStage(stage)) {
    throw new EngineError("invalid_input", `${jobType} is not one of the 14 engine stages`);
  }
  return stage;
}

/** Meridian's jobs.priority for a request priority. Lower numbers run first: rush before normal before batch (Bible 5.1). */
export function priorityNumber(priority: RequestPriority): number {
  const value = jobSettings.priority[priority];
  if (value === undefined) {
    throw new EngineError("invalid_input", `priority ${String(priority)} is not rush, normal or batch`);
  }
  return value;
}

/**
 * Idempotency key of one stage job: engine:<requestId>:<stage>:<subjectId>:<attempt> (Bible 5.1). Identical inputs give the same
 * key, so a second insert of the same job does nothing. A subject or attempt may not contain ':' (it would blur the key).
 */
export function engineJobKey(input: { requestId: string; stage: string; subjectId: string; attempt: number | string }): string {
  const attempt = String(input.attempt);
  for (const [name, value] of [
    ["requestId", input.requestId],
    ["stage", input.stage],
    ["subjectId", input.subjectId],
    ["attempt", attempt],
  ] as const) {
    if (value.length === 0 || value.includes(":")) {
      throw new EngineError("invalid_input", `${name} of an engine job key must be non-empty and free of ':'`);
    }
  }
  return `engine:${input.requestId}:${input.stage}:${input.subjectId}:${attempt}`;
}
