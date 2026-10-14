// Pure orchestrator core (Video Engine Bible 3, 5.1 to 5.3, 6.1 to 6.14). advance(state, event) applies one event and
// returns the jobs that are now ready, the effects to persist and the next state. It does no I/O and reads no clock, so a
// replay of the same state and event gives the same jobs with the same idempotency keys.
//
// Scheduling is state-driven: after an event is applied, every node whose inputs are ready and that is not yet queued is
// queued. A paused request queues nothing until it is resumed. Results that arrive while paused are still recorded.

import { EngineError, type Decision, type GateId, type GateResult, type ModelClass, type TakeVerdict } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { STAGE_SPECS, engineJobKey, priorityNumber, type EngineStage } from "./registry.ts";
import { jobSettings, type RequestPriority } from "./settings.ts";
import type { EngineEvent, EnginePayload, QueuedJob, ShotSourceKind, ShotSummary, StageOutput } from "./types.ts";

export const ORCHESTRATOR_STATE_SCHEMA = "engine.orchestrator_state/v1" as const;

/** The stages that run once per request. Shots, takes and branches are tracked in their own maps. */
export const SINGLE_NODES = ["intake", "analyze_reference", "voice", "plan", "estimate_reserve", "edit", "variants", "deliver"] as const;
export type SingleNode = (typeof SINGLE_NODES)[number];

/** Branch stages: the chain from an EDL to a delivered video (stages 9 to 12). "done" means the branch passed review. */
export type BranchStage = "compose" | "pre_render_gate" | "render" | "post_render_review" | "done";

type NodeState = { status: "idle" | "queued" | "passed"; redos: number; hints: string[] };

export type ShotState = ShotSummary & {
  status: "pending" | "accepted" | "replanning" | "escalated";
  /** Produce rounds, starting at 0. A redo starts a new round (qualityAttempt, Bible 5.3). */
  round: number;
  /** Produce jobs queued in the current round. */
  issued: number;
  replanQueued: boolean;
  /** Set when the downgrade replan failed its gate. Resume runs the replan again; a human cannot pick a take for it. */
  replanFailed: boolean;
  hints: string[];
  acceptedTakeId: string | null;
  downgrades: number;
};

export type TakeVerdictState = {
  pass: boolean;
  confidence: number;
  /** Rule names of the failing checks. Never free text from a model (Bible 1, trust boundaries). */
  failing: string[];
  criticEscalates: boolean;
  verdictArtifactId: string | null;
};

export type TakeState = {
  takeId: string;
  shotId: string;
  round: number;
  checkQueued: boolean;
  verdict: TakeVerdictState | null;
};

export type BranchState = {
  edlId: string;
  variantOf: string | null;
  stage: BranchStage;
  queued: boolean;
  status: "running" | "passed" | "escalated" | "superseded";
  redos: Partial<Record<BranchStage, number>>;
  hints: string[];
};

export type Pause = { kind: "budget" | "dead_letter" | "escalation"; stage: EngineStage; subjectId: string; reason: string };

export type OrchestratorState = {
  schema: typeof ORCHESTRATOR_STATE_SCHEMA;
  requestId: string;
  organizationId: string;
  priority: RequestPriority;
  status: "running" | "paused" | "rejected" | "delivered";
  pause: Pause | null;
  cachedDna: boolean;
  variantCount: number;
  budgetReservationId: string | null;
  nodes: Record<SingleNode, NodeState>;
  shots: Record<string, ShotState>;
  takes: Record<string, TakeState>;
  branches: Record<string, BranchState>;
  masterEdlId: string | null;
  /** How many jobs were queued per "stage|subject". The next attempt number is one more than this. */
  sequences: Record<string, number>;
  /** Latest artifact id per slot: "request", "validated", "dna", "voice", "plan", "take:<id>", "verdict:<id>", "edl:<id>", ... */
  artifacts: Record<string, string>;
  manifestId: string | null;
};

export type EngineEffect =
  | { kind: "gate"; gate: GateResult }
  | { kind: "decision"; decision: Decision }
  | { kind: "review_item"; reviewKind: "escalation" | "dead_letter"; reason: string; subjectId: string; detail: Record<string, unknown> }
  | { kind: "rejected"; reasons: string[] }
  | { kind: "gold_label"; shotId: string; takeId: string }
  | { kind: "delivered"; manifestId: string };

export type AdvanceResult = { state: OrchestratorState; jobs: QueuedJob[]; effects: EngineEffect[] };

/** Limits read from configuration (Bible 5.3, 6.2, 6.3, 6.4, 12.2). */
export const orchestratorLimits = {
  /** qualityRedosPerShot: redos per shot before its downgrade (Bible 5.1, 5.3). */
  shotRedos: thresholds.jobs.qualityRedosPerShot,
  /** Critic confidence below this escalates (Bible 5.3, initial 0.6). */
  criticConfidenceMin: thresholds.escalation.criticConfidence.value,
  /** Voice retries with a faster pace, then escalation (Bible 6.3). */
  voiceRedos: thresholds.voice.paceRetries,
  /** Plan validation fails twice, then escalation: one redo follows the first failure (Bible 6.4). */
  planRedos: thresholds.plan.validationAttemptsBeforeEscalation - 1,
  /** Analysis retries once with denser frames (Bible 6.2). */
  analyzeRedos: jobSettings.analyzeRetries,
  /** Edit, compose, render and post-render redos before escalation. Shares the shot redo limit. */
  stageRedos: thresholds.jobs.qualityRedosPerShot,
} as const;

const GATE_FOR_STAGE: Partial<Record<EngineStage, GateId>> = {
  intake: "request",
  analyze_reference: "dna",
  voice: "voice",
  plan: "plan",
  estimate_reserve: "budget",
  check_take: "take",
  edit: "edit",
  pre_render_gate: "pre_render",
  render: "render_integrity",
  post_render_review: "post_render",
};

const MAX_HINTS = 8;

function invalid(message: string, stage?: string): never {
  throw new EngineError("invalid_input", message, { stage });
}

function conflict(message: string, stage?: string): never {
  throw new EngineError("conflict", message, { stage });
}

/** The provider concurrency bucket of a produce job (Bible 10.4). Stock has its own bucket. */
export function providerKeyFor(sourceKind: ShotSourceKind, modelClass: ModelClass | null): string {
  if (sourceKind === "stock") return "stock";
  if (modelClass === "tts") return "tts";
  if (modelClass !== null && modelClass.startsWith("image.")) return "image";
  return "video";
}

/** Only generation and stock need a produce job. Components are rendered in the composition; assets already exist. */
export function needsProduce(sourceKind: ShotSourceKind): boolean {
  return sourceKind === "generate" || sourceKind === "stock";
}

function failingRules(gate: GateResult): string[] {
  return [...new Set(gate.checks.filter((check) => !check.pass).map((check) => check.rule))].sort().slice(0, MAX_HINTS);
}

function verdictRules(verdict: TakeVerdict): string[] {
  return [...new Set(verdict.checks.filter((check) => !check.pass).map((check) => check.rule))].sort().slice(0, MAX_HINTS);
}

function reasonsOf(gate: GateResult): string[] {
  const reasons = gate.checks.filter((check) => !check.pass).map((check) => (check.detail ? `${check.rule}: ${check.detail}` : check.rule));
  return reasons.length > 0 ? reasons : [`${gate.gate} gate failed`];
}

function initialState(event: Extract<EngineEvent, { type: "start" }>): OrchestratorState {
  if (!Number.isInteger(event.variantCount) || event.variantCount < 0) {
    invalid("variantCount must be a whole number of zero or more");
  }
  const idle = (): NodeState => ({ status: "idle", redos: 0, hints: [] });
  const nodes: OrchestratorState["nodes"] = {
    intake: idle(),
    analyze_reference: idle(),
    voice: idle(),
    plan: idle(),
    estimate_reserve: idle(),
    edit: idle(),
    variants: idle(),
    deliver: idle(),
  };
  return {
    schema: ORCHESTRATOR_STATE_SCHEMA,
    requestId: event.requestId,
    organizationId: event.organizationId,
    priority: event.priority,
    status: "running",
    pause: null,
    cachedDna: event.cachedDna,
    variantCount: event.variantCount,
    budgetReservationId: null,
    nodes,
    shots: {},
    takes: {},
    branches: {},
    masterEdlId: null,
    sequences: {},
    artifacts: {
      request: event.requestArtifactId,
      ...(event.cachedDnaArtifactId ? { dna: event.cachedDnaArtifactId } : {}),
    },
    manifestId: null,
  };
}

/**
 * Apply one event and schedule what is ready. A null state is valid only for the start event. Events that cannot happen in
 * the current state throw a conflict error, so a stale or duplicate result never moves the graph.
 */
export function advance(current: OrchestratorState | null, event: EngineEvent): AdvanceResult {
  if (event.type === "start") {
    if (current !== null) conflict("this request has already started");
    const state = initialState(event);
    return { state, jobs: schedule(state), effects: [] };
  }
  if (current === null) throw new EngineError("not_found", "this request has no orchestrator state");
  if (current.status === "rejected" || current.status === "delivered") {
    conflict(`the request is ${current.status}; ${event.type} cannot change it`);
  }
  const state = structuredClone(current);
  const effects: EngineEffect[] = [];
  switch (event.type) {
    case "succeeded":
      applyOutput(state, event.output, effects);
      break;
    case "dead":
      applyDead(state, event, effects);
      break;
    case "resume":
      applyResume(state);
      break;
    case "human_choice":
      applyHumanChoice(state, event, effects);
      break;
  }
  return { state, jobs: schedule(state), effects };
}

// --- Applying results ------------------------------------------------------------------------------------------------

function applyOutput(state: OrchestratorState, output: StageOutput, effects: EngineEffect[]): void {
  switch (output.stage) {
    case "intake":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyIntake(state, output, effects);
    case "analyze_reference":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applySingleGate(state, "analyze_reference", output, effects, orchestratorLimits.analyzeRedos);
    case "voice":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applySingleGate(state, "voice", output, effects, orchestratorLimits.voiceRedos);
    case "plan":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyPlan(state, output, effects);
    case "estimate_reserve":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyEstimate(state, output);
    case "produce_shot":
      return applyProduce(state, output);
    case "check_take":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyCheck(state, output, effects);
    case "edit":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyEdit(state, output, effects);
    case "compose":
      return applyCompose(state, output);
    case "pre_render_gate":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyPreRender(state, output, effects);
    case "render":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyRender(state, output, effects);
    case "post_render_review":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyPostRender(state, output, effects);
    case "variants":
      return applyVariants(state, output);
    case "deliver":
      return applyDeliver(state, output, effects);
  }
}

function checkGate(stage: EngineStage, gate: GateResult): void {
  const expected = GATE_FOR_STAGE[stage];
  if (expected !== undefined && gate.gate !== expected) {
    invalid(`${stage} must report the ${expected} gate, not ${gate.gate}`, stage);
  }
}

function mergeArtifacts(state: OrchestratorState, artifacts: Record<string, string>): void {
  for (const [slot, id] of Object.entries(artifacts)) state.artifacts[slot] = id;
}

function expectQueued(state: OrchestratorState, node: SingleNode, subjectId: string): void {
  if (state.nodes[node].status !== "queued") conflict(`${node} is not waiting for a result`, node);
  if (subjectId !== state.requestId) invalid(`${node} reports for ${subjectId}, not for the request`, node);
}

function pauseWith(state: OrchestratorState, pause: Pause): void {
  if (state.pause === null) state.pause = pause;
  state.status = "paused";
}

function escalateRequest(state: OrchestratorState, pause: Pause, detail: Record<string, unknown>, effects: EngineEffect[]): void {
  pauseWith(state, pause);
  effects.push({ kind: "review_item", reviewKind: "escalation", reason: pause.reason, subjectId: pause.subjectId, detail });
}

function applyIntake(state: OrchestratorState, output: Extract<StageOutput, { stage: "intake" }>, effects: EngineEffect[]): void {
  expectQueued(state, "intake", output.subjectId);
  mergeArtifacts(state, output.artifacts);
  if (!output.gate.pass) {
    state.nodes.intake.status = "idle";
    state.status = "rejected";
    effects.push({ kind: "rejected", reasons: reasonsOf(output.gate) });
    return;
  }
  if (output.budgetReservationId === null) {
    // Fail closed: the paid stages that follow cannot be queued without a reservation on the request (Bible 14).
    state.nodes.intake.status = "idle";
    pauseWith(state, {
      kind: "budget",
      stage: "intake",
      subjectId: state.requestId,
      reason: "intake passed without a budget reservation. No paid stage is queued without one (Bible 14).",
    });
    return;
  }
  state.budgetReservationId = output.budgetReservationId;
  state.nodes.intake.status = "passed";
  if (state.cachedDna) state.nodes.analyze_reference.status = "passed";
}

function applySingleGate(
  state: OrchestratorState,
  node: "analyze_reference" | "voice",
  output: { subjectId: string; artifacts: Record<string, string>; gate: GateResult },
  effects: EngineEffect[],
  redoLimit: number,
): void {
  expectQueued(state, node, output.subjectId);
  mergeArtifacts(state, output.artifacts);
  if (output.gate.pass) {
    state.nodes[node].status = "passed";
    return;
  }
  failNode(state, node, output.gate, redoLimit, effects);
}

/** A failed single-node gate: redo while the limit allows, then escalate the request (Bible 5.3, 6.2 to 6.4). */
function failNode(state: OrchestratorState, node: SingleNode, gate: GateResult, redoLimit: number, effects: EngineEffect[]): void {
  const slot = state.nodes[node];
  slot.status = "idle";
  if (slot.redos < redoLimit) {
    slot.redos += 1;
    slot.hints = failingRules(gate);
    return;
  }
  escalateRequest(
    state,
    { kind: "escalation", stage: node, subjectId: state.requestId, reason: `${node} failed its ${gate.gate} gate after ${redoLimit} redos` },
    { gate: gate.gate, rules: failingRules(gate) },
    effects,
  );
}

function shotFromSummary(summary: ShotSummary, downgrades: number): ShotState {
  return {
    ...summary,
    status: needsProduce(summary.sourceKind) ? "pending" : "accepted",
    round: 0,
    issued: 0,
    replanQueued: false,
    replanFailed: false,
    hints: [],
    acceptedTakeId: null,
    downgrades,
  };
}

function applyPlan(state: OrchestratorState, output: Extract<StageOutput, { stage: "plan" }>, effects: EngineEffect[]): void {
  if (output.subjectId === state.requestId) {
    expectQueued(state, "plan", output.subjectId);
    mergeArtifacts(state, output.artifacts);
    if (!output.gate.pass) {
      failNode(state, "plan", output.gate, orchestratorLimits.planRedos, effects);
      return;
    }
    if (output.shots.length === 0) invalid("a plan that passed its gate has no shots", "plan");
    const seen = new Set<string>();
    for (const summary of output.shots) {
      if (seen.has(summary.shotId)) invalid(`the plan lists shot ${summary.shotId} twice`, "plan");
      seen.add(summary.shotId);
    }
    for (const summary of output.shots) state.shots[summary.shotId] = shotFromSummary(summary, 0);
    state.nodes.plan.status = "passed";
    return;
  }

  // A downgrade replan for one shot (Bible 5.3): the planner swaps that shot's visual type.
  const shot = state.shots[output.subjectId];
  if (!shot || shot.status !== "replanning") conflict(`plan reports for ${output.subjectId}, which is not waiting for a replan`, "plan");
  mergeArtifacts(state, output.artifacts);
  shot.replanQueued = false;
  if (!output.gate.pass) {
    shot.replanFailed = true;
    escalateShot(state, shot, `the plan gate failed for the downgrade of ${shot.shotId}`, effects);
    return;
  }
  const summary = output.shots.find((candidate) => candidate.shotId === shot.shotId);
  if (!summary) invalid(`the replanned plan has no shot ${shot.shotId}`, "plan");
  state.shots[shot.shotId] = shotFromSummary(summary, shot.downgrades);
}

function applyEstimate(state: OrchestratorState, output: Extract<StageOutput, { stage: "estimate_reserve" }>): void {
  expectQueued(state, "estimate_reserve", output.subjectId);
  mergeArtifacts(state, output.artifacts);
  if (!output.gate.pass || output.budgetReservationId === null) {
    state.nodes.estimate_reserve.status = "idle";
    const reason = output.gate.pass ? "the estimate returned no reservation" : reasonsOf(output.gate).join("; ");
    pauseWith(state, { kind: "budget", stage: "estimate_reserve", subjectId: state.requestId, reason: `Budget: ${reason}` });
    return;
  }
  state.budgetReservationId = output.budgetReservationId;
  state.nodes.estimate_reserve.status = "passed";
}

function applyProduce(state: OrchestratorState, output: Extract<StageOutput, { stage: "produce_shot" }>): void {
  const shot = state.shots[output.shotId];
  if (!shot || shot.status !== "pending") conflict(`shot ${output.shotId} is not waiting for a take`, "produce_shot");
  if (output.subjectId !== output.shotId) invalid("produce_shot must report for its own shot", "produce_shot");
  if (state.takes[output.takeId]) conflict(`take ${output.takeId} was already recorded`, "produce_shot");
  state.takes[output.takeId] = { takeId: output.takeId, shotId: output.shotId, round: shot.round, checkQueued: false, verdict: null };
  mergeArtifacts(state, output.artifacts);
}

function applyCheck(state: OrchestratorState, output: Extract<StageOutput, { stage: "check_take" }>, effects: EngineEffect[]): void {
  const take = state.takes[output.takeId];
  if (!take || take.verdict !== null) conflict(`take ${output.takeId} is not waiting for a verdict`, "check_take");
  if (take.shotId !== output.shotId || output.subjectId !== output.takeId) invalid("check_take reports for another shot or take", "check_take");
  if (output.gate.pass !== output.verdict.pass) invalid("the take gate and the verdict disagree", "check_take");
  mergeArtifacts(state, output.artifacts);
  take.verdict = {
    pass: output.verdict.pass,
    confidence: output.verdict.confidence,
    failing: verdictRules(output.verdict),
    criticEscalates: output.verdict.action === "escalate",
    verdictArtifactId: output.artifacts[`verdict:${output.takeId}`] ?? null,
  };
  const shot = state.shots[take.shotId];
  if (shot && shot.status === "pending") resolveRound(state, shot, effects);
}

/** Once every take of the current round has a verdict, act on the round (Bible 5.3). */
function resolveRound(state: OrchestratorState, shot: ShotState, effects: EngineEffect[]): void {
  const round = takesOf(state, shot.shotId, shot.round);
  if (shot.issued < shot.takesWanted || round.length < shot.takesWanted) return;
  const verdicts = round.map((take) => take.verdict);
  if (verdicts.some((verdict) => verdict === null)) return;
  const settled = verdicts as TakeVerdictState[];

  const lowConfidence = round.filter((take) => take.verdict !== null && take.verdict.confidence < orchestratorLimits.criticConfidenceMin);
  if (lowConfidence.length > 0) {
    const ids = lowConfidence.map((take) => take.takeId).join(", ");
    escalateShot(state, shot, `Critic confidence is below ${orchestratorLimits.criticConfidenceMin} on ${ids}`, effects);
    return;
  }
  if (settled.some((verdict) => verdict.criticEscalates)) {
    escalateShot(state, shot, `the Critic asked for escalation on ${shot.shotId}`, effects);
    return;
  }

  const passing = round
    .filter((take) => take.verdict?.pass === true)
    .sort((a, b) => (b.verdict?.confidence ?? 0) - (a.verdict?.confidence ?? 0) || a.takeId.localeCompare(b.takeId));
  if (passing.length > 0) {
    shot.status = "accepted";
    shot.acceptedTakeId = passing[0]?.takeId ?? null;
    return;
  }
  if (shot.round < orchestratorLimits.shotRedos) {
    shot.round += 1;
    shot.issued = 0;
    shot.hints = [...new Set(settled.flatMap((verdict) => verdict.failing))].sort().slice(0, MAX_HINTS);
    return;
  }
  downgradeOrEscalate(state, shot, `${orchestratorLimits.shotRedos} redos of ${shot.shotId} failed`, effects);
}

function takesOf(state: OrchestratorState, shotId: string, round: number): TakeState[] {
  return Object.values(state.takes)
    .filter((take) => take.shotId === shotId && take.round === round)
    .sort((a, b) => a.takeId.localeCompare(b.takeId));
}

function downgradeOrEscalate(state: OrchestratorState, shot: ShotState, why: string, effects: EngineEffect[]): void {
  if (shot.downgradeTo !== null) {
    shot.status = "replanning";
    shot.replanQueued = false;
    shot.downgrades += 1;
    effects.push({
      kind: "decision",
      decision: {
        at: `shot:${shot.shotId}`,
        chose: shot.downgradeTo,
        alternatives: [],
        reason: `${why}; downgraded from ${shot.visualType} to ${shot.downgradeTo} (Video Engine Bible 5.3)`,
        by: "scorer",
      },
    });
    return;
  }
  escalateShot(state, shot, `${why}, and ${shot.shotId} has no downgrade`, effects);
}

/** The review item lists every take of the shot, across all rounds, with its verdict artifact (Bible 5.3). */
function escalateShot(state: OrchestratorState, shot: ShotState, reason: string, effects: EngineEffect[]): void {
  shot.status = "escalated";
  pauseWith(state, { kind: "escalation", stage: "check_take", subjectId: shot.shotId, reason });
  const takes = Object.values(state.takes)
    .filter((take) => take.shotId === shot.shotId)
    .sort((a, b) => a.takeId.localeCompare(b.takeId));
  effects.push({
    kind: "review_item",
    reviewKind: "escalation",
    reason,
    subjectId: shot.shotId,
    detail: {
      shotId: shot.shotId,
      visualType: shot.visualType,
      planArtifactId: state.artifacts.plan ?? null,
      takes: takes.map((take) => ({
        takeId: take.takeId,
        takeArtifactId: state.artifacts[`take:${take.takeId}`] ?? null,
        pass: take.verdict?.pass ?? null,
        confidence: take.verdict?.confidence ?? null,
        failing: take.verdict?.failing ?? [],
        verdictArtifactId: take.verdict?.verdictArtifactId ?? null,
      })),
    },
  });
}

function applyEdit(state: OrchestratorState, output: Extract<StageOutput, { stage: "edit" }>, effects: EngineEffect[]): void {
  expectQueued(state, "edit", output.subjectId);
  mergeArtifacts(state, output.artifacts);
  if (!output.gate.pass) {
    failNode(state, "edit", output.gate, orchestratorLimits.stageRedos, effects);
    return;
  }
  const previous = state.masterEdlId === null ? undefined : state.branches[state.masterEdlId];
  if (previous && previous.status === "running") previous.status = "superseded";
  state.masterEdlId = output.edlId;
  state.branches[output.edlId] = newBranch(output.edlId, null);
  state.nodes.edit.status = "passed";
}

function newBranch(edlId: string, variantOf: string | null): BranchState {
  return { edlId, variantOf, stage: "compose", queued: false, status: "running", redos: {}, hints: [] };
}

/** The branch must be waiting on exactly this stage. Anything else is a stale or duplicate result. */
function expectBranch(state: OrchestratorState, edlId: string, stage: BranchStage, stageName: EngineStage): BranchState {
  const branch = state.branches[edlId];
  if (!branch || !branch.queued || branch.stage !== stage || branch.status !== "running") {
    conflict(`${stageName} for ${edlId} is not waiting for a result`, stageName);
  }
  return branch;
}

function applyCompose(state: OrchestratorState, output: Extract<StageOutput, { stage: "compose" }>): void {
  const branch = expectBranch(state, output.edlId, "compose", "compose");
  if (output.subjectId !== output.edlId) invalid("compose must report for its EDL", "compose");
  mergeArtifacts(state, output.artifacts);
  branch.queued = false;
  branch.hints = [];
  branch.stage = "pre_render_gate";
}

function applyPreRender(state: OrchestratorState, output: Extract<StageOutput, { stage: "pre_render_gate" }>, effects: EngineEffect[]): void {
  const branch = expectBranch(state, output.edlId, "pre_render_gate", "pre_render_gate");
  mergeArtifacts(state, output.artifacts);
  branch.queued = false;
  if (output.gate.pass) {
    branch.stage = "render";
    branch.hints = [];
    return;
  }
  const shots = failingShotIds(state, output.gate);
  if (shots.length > 0) {
    reviseFromShots(state, branch, shots, output.gate, effects);
    return;
  }
  reviseEdit(state, branch, output.gate, effects, "the pre-render gate failed");
}

function applyRender(state: OrchestratorState, output: Extract<StageOutput, { stage: "render" }>, effects: EngineEffect[]): void {
  const branch = expectBranch(state, output.edlId, "render", "render");
  mergeArtifacts(state, output.artifacts);
  branch.queued = false;
  if (output.gate.pass) {
    branch.stage = "post_render_review";
    branch.hints = [];
    return;
  }
  retryBranchStage(state, branch, "render", output.gate, effects, `render integrity failed after ${orchestratorLimits.stageRedos} redos`);
}

function applyPostRender(state: OrchestratorState, output: Extract<StageOutput, { stage: "post_render_review" }>, effects: EngineEffect[]): void {
  const branch = expectBranch(state, output.edlId, "post_render_review", "post_render_review");
  mergeArtifacts(state, output.artifacts);
  branch.queued = false;
  if (output.gate.pass) {
    branch.stage = "done";
    branch.status = "passed";
    branch.hints = [];
    return;
  }
  const shots = failingShotIds(state, output.gate);
  if (shots.length > 0) {
    reviseFromShots(state, branch, shots, output.gate, effects);
    return;
  }
  retryBranchStage(state, branch, "compose", output.gate, effects, `post-render review failed after ${orchestratorLimits.stageRedos} redos`);
}

function failingShotIds(state: OrchestratorState, gate: GateResult): string[] {
  return [...new Set(gate.failingShotIds ?? [])].filter((id) => state.shots[id] !== undefined).sort();
}

/** A branch stage failed with no shot to blame: redo that stage up to the limit, then escalate. */
function retryBranchStage(state: OrchestratorState, branch: BranchState, stage: BranchStage, gate: GateResult, effects: EngineEffect[], reason: string): void {
  const redos = branch.redos[stage] ?? 0;
  if (redos < orchestratorLimits.stageRedos) {
    branch.redos[stage] = redos + 1;
    branch.stage = stage;
    branch.hints = failingRules(gate);
    return;
  }
  escalateBranch(state, branch, `${reason} (${gate.gate})`, effects);
}

/** The composition failed a check that names no shot: the EDL is rebuilt (edit is code, no model call). */
function reviseEdit(state: OrchestratorState, branch: BranchState, gate: GateResult, effects: EngineEffect[], reason: string): void {
  const redos = state.nodes.edit.redos;
  if (redos < orchestratorLimits.stageRedos) {
    supersedeBranch(branch);
    state.nodes.edit.redos = redos + 1;
    state.nodes.edit.status = "idle";
    state.nodes.edit.hints = failingRules(gate);
    return;
  }
  escalateBranch(state, branch, `${reason}, and the edit was redone ${orchestratorLimits.stageRedos} times`, effects);
}

/** A shot-level failure found after the EDL exists: each named shot is redone, downgraded or escalated; the EDL is rebuilt. */
function reviseFromShots(state: OrchestratorState, branch: BranchState, shotIds: string[], gate: GateResult, effects: EngineEffect[]): void {
  for (const shotId of shotIds) {
    const shot = state.shots[shotId];
    if (!shot || shot.status !== "accepted") continue;
    // A component or asset shot has no produce job, so a redo would wait forever. It goes straight to downgrade or escalate.
    if (needsProduce(shot.sourceKind) && shot.round < orchestratorLimits.shotRedos) {
      shot.round += 1;
      shot.issued = 0;
      shot.status = "pending";
      shot.acceptedTakeId = null;
      shot.hints = failingRules(gate);
      continue;
    }
    downgradeOrEscalate(state, shot, `the ${gate.gate} gate named ${shotId} after ${orchestratorLimits.shotRedos} redos`, effects);
  }
  supersedeBranch(branch);
  state.nodes.edit.status = "idle";
  state.nodes.edit.hints = failingRules(gate);
}

function supersedeBranch(branch: BranchState): void {
  branch.status = "superseded";
  branch.queued = false;
}

function escalateBranch(state: OrchestratorState, branch: BranchState, reason: string, effects: EngineEffect[]): void {
  branch.status = "escalated";
  branch.queued = false;
  if (branch.variantOf === null) {
    pauseWith(state, { kind: "escalation", stage: branchStageName(branch.stage), subjectId: branch.edlId, reason });
  }
  effects.push({
    kind: "review_item",
    reviewKind: "escalation",
    reason,
    subjectId: branch.edlId,
    detail: { edlId: branch.edlId, variantOf: branch.variantOf, stage: branch.stage },
  });
}

function branchStageName(stage: BranchStage): EngineStage {
  return stage === "done" ? "post_render_review" : stage;
}

function applyVariants(state: OrchestratorState, output: Extract<StageOutput, { stage: "variants" }>): void {
  expectQueued(state, "variants", output.subjectId);
  if (state.masterEdlId === null) conflict("variants ran without a master EDL", "variants");
  mergeArtifacts(state, output.artifacts);
  for (const variant of output.variants) {
    if (state.branches[variant.edlId]) invalid(`variant ${variant.edlId} already has a branch`, "variants");
    state.branches[variant.edlId] = newBranch(variant.edlId, state.masterEdlId);
  }
  state.nodes.variants.status = "passed";
}

function applyDeliver(state: OrchestratorState, output: Extract<StageOutput, { stage: "deliver" }>, effects: EngineEffect[]): void {
  expectQueued(state, "deliver", output.subjectId);
  mergeArtifacts(state, output.artifacts);
  state.nodes.deliver.status = "passed";
  state.status = "delivered";
  state.manifestId = output.manifestId;
  effects.push({ kind: "delivered", manifestId: output.manifestId });
}

/**
 * A job exhausted its attempts (Bible 5.1, 15.5). The stage it ran goes back to not-in-flight so a resume re-queues it,
 * and the request pauses with its artifacts intact.
 */
function applyDead(state: OrchestratorState, event: Extract<EngineEvent, { type: "dead" }>, effects: EngineEffect[]): void {
  const { stage, subjectId, reason } = event;
  if (isSingleNode(stage) && subjectId === state.requestId) {
    const node = state.nodes[stage];
    if (node.status !== "queued") conflict(`${stage} is not queued, so its dead job cannot apply`, stage);
    node.status = "idle";
  } else if (stage === "plan") {
    const shot = state.shots[subjectId];
    if (!shot || shot.status !== "replanning") conflict(`the replan of ${subjectId} is not in flight`, stage);
    shot.replanQueued = false;
  } else if (stage === "produce_shot") {
    const shot = state.shots[subjectId];
    if (!shot || shot.status !== "pending" || shot.issued === 0) conflict(`produce for ${subjectId} is not in flight`, stage);
    shot.issued -= 1;
  } else if (stage === "check_take") {
    const take = state.takes[subjectId];
    if (!take || !take.checkQueued || take.verdict !== null) conflict(`check for ${subjectId} is not in flight`, stage);
    take.checkQueued = false;
  } else if (stage === "compose" || stage === "pre_render_gate" || stage === "render" || stage === "post_render_review") {
    const branch = state.branches[subjectId];
    if (!branch || !branch.queued) conflict(`${stage} for ${subjectId} is not in flight`, stage);
    branch.queued = false;
  } else {
    conflict(`${stage} for ${subjectId} cannot be in flight`, stage);
  }
  pauseWith(state, { kind: "dead_letter", stage, subjectId, reason });
  effects.push({ kind: "review_item", reviewKind: "dead_letter", reason, subjectId, detail: { stage, subjectId } });
}

function isSingleNode(stage: string): stage is SingleNode {
  return (SINGLE_NODES as readonly string[]).includes(stage);
}

/**
 * Lift a pause. A shot that needs a human choice blocks the resume (Bible 5.3). Escalated stages get fresh redo budgets, so a
 * human decision starts the stage again rather than failing straight back into escalation.
 */
function applyResume(state: OrchestratorState): void {
  if (state.status !== "paused") conflict("the request is not paused");
  for (const shot of Object.values(state.shots)) {
    if (shot.status !== "escalated") continue;
    // A downgrade replan that failed its gate is tried again on resume. Any other escalation needs a human choice first.
    if (shot.replanFailed) {
      shot.status = "replanning";
      shot.replanQueued = false;
      shot.replanFailed = false;
      continue;
    }
    conflict(`shot ${shot.shotId} needs a human choice before the request resumes`);
  }
  const pause = state.pause;
  if (pause !== null && pause.kind === "escalation" && isSingleNode(pause.stage)) {
    state.nodes[pause.stage].redos = 0;
  }
  for (const branch of Object.values(state.branches)) {
    if (branch.variantOf === null && branch.status === "escalated") {
      branch.status = "running";
      branch.queued = false;
      if (branch.stage !== "done") branch.redos[branch.stage] = 0;
    }
  }
  state.pause = null;
  state.status = "running";
}

/** A person picked a take for an escalated shot. The take is stored as a gold-set label (Bible 5.3, 16). */
function applyHumanChoice(state: OrchestratorState, event: Extract<EngineEvent, { type: "human_choice" }>, effects: EngineEffect[]): void {
  const shot = state.shots[event.shotId];
  const take = state.takes[event.takeId];
  if (!shot || shot.status !== "escalated" || shot.replanFailed) conflict(`shot ${event.shotId} is not waiting for a human choice`);
  if (!take || take.shotId !== shot.shotId) invalid(`take ${event.takeId} is not a take of ${event.shotId}`);
  shot.status = "accepted";
  shot.acceptedTakeId = take.takeId;
  effects.push({ kind: "gold_label", shotId: shot.shotId, takeId: take.takeId });
  const stillEscalated = Object.values(state.shots).some((candidate) => candidate.status === "escalated");
  if (!stillEscalated && state.pause?.kind === "escalation") {
    state.pause = null;
    state.status = "running";
  }
}

// --- Scheduling -------------------------------------------------------------------------------------------------------

function nextAttempt(state: OrchestratorState, stage: EngineStage, subjectId: string): string {
  const slot = `${stage}|${subjectId}`;
  const attempt = (state.sequences[slot] ?? 0) + 1;
  state.sequences[slot] = attempt;
  return String(attempt);
}

function allShotsAccepted(state: OrchestratorState): boolean {
  const shots = Object.values(state.shots);
  return shots.length > 0 && shots.every((shot) => shot.status === "accepted");
}

function masterPassed(state: OrchestratorState): boolean {
  return state.masterEdlId !== null && state.branches[state.masterEdlId]?.status === "passed";
}

function variantsSettled(state: OrchestratorState): boolean {
  return Object.values(state.branches).every((branch) => branch.variantOf === null || branch.status !== "running");
}

function branchSlots(branch: BranchState): string[] {
  const edl = `edl:${branch.edlId}`;
  switch (branch.stage) {
    case "compose":
      return [edl];
    case "pre_render_gate":
      return [`composition:${branch.edlId}`, edl];
    case "render":
      return [`composition:${branch.edlId}`];
    case "post_render_review":
      return [`render:${branch.edlId}`, edl];
    case "done":
      return [];
  }
}

/** Queue every job that is ready and not yet queued. Mutates the state it is given (the caller passes a copy). */
function schedule(state: OrchestratorState): QueuedJob[] {
  if (state.status !== "running") return [];
  const jobs: QueuedJob[] = [];

  const add = (stage: EngineStage, subjectId: string, details: Record<string, unknown>, slots: string[], hints: string[]): void => {
    const spec = STAGE_SPECS[stage];
    if (spec.paid && state.budgetReservationId === null) {
      throw new EngineError("invalid_input", `${stage} is a paid stage and needs a budget reservation on the request (Bible 14)`, { stage });
    }
    const attempt = nextAttempt(state, stage, subjectId);
    const inputArtifactIds = [...new Set(slots.map((slot) => state.artifacts[slot]).filter((id): id is string => id !== undefined))];
    const payload: EnginePayload = {
      organizationId: state.organizationId,
      requestId: state.requestId,
      stage,
      subjectId,
      attempt,
      priority: state.priority,
      budgetReservationId: state.budgetReservationId,
      inputArtifactIds,
      hints,
      details,
    };
    jobs.push({
      stage,
      subjectId,
      attempt,
      key: engineJobKey({ requestId: state.requestId, stage, subjectId, attempt }),
      priority: priorityNumber(state.priority),
      paid: spec.paid,
      maxAttempts: spec.maxAttempts,
      payload,
    });
  };

  const n = state.nodes;
  const ready: Record<SingleNode, boolean> = {
    intake: true,
    analyze_reference: n.intake.status === "passed" && !state.cachedDna,
    voice: n.intake.status === "passed",
    plan: n.analyze_reference.status === "passed" && n.voice.status === "passed",
    estimate_reserve: n.plan.status === "passed",
    edit: n.estimate_reserve.status === "passed" && allShotsAccepted(state),
    variants: masterPassed(state) && state.variantCount > 0,
    deliver: masterPassed(state) && (state.variantCount === 0 || (n.variants.status === "passed" && variantsSettled(state))),
  };
  const nodeSlots: Record<SingleNode, string[]> = {
    intake: ["request"],
    analyze_reference: ["request"],
    voice: ["request"],
    plan: ["validated", "dna", "voice"],
    estimate_reserve: ["plan"],
    edit: ["plan", "dna", "voice", ...Object.values(state.shots).flatMap((shot) => (shot.acceptedTakeId ? [`take:${shot.acceptedTakeId}`] : []))],
    variants: state.masterEdlId === null ? [] : [`edl:${state.masterEdlId}`],
    deliver: Object.keys(state.artifacts),
  };
  for (const node of SINGLE_NODES) {
    if (n[node].status !== "idle" || !ready[node]) continue;
    n[node].status = "queued";
    const hints = n[node].hints;
    n[node].hints = [];
    add(node, state.requestId, nodeDetails(state, node), nodeSlots[node], hints);
  }

  const shots = Object.values(state.shots).sort((a, b) => a.shotId.localeCompare(b.shotId));
  if (n.estimate_reserve.status === "passed") {
    for (const shot of shots) {
      if (shot.status !== "pending" || !needsProduce(shot.sourceKind)) continue;
      const hints = shot.hints;
      while (shot.issued < shot.takesWanted) {
        shot.issued += 1;
        add(
          "produce_shot",
          shot.shotId,
          {
            shotId: shot.shotId,
            visualType: shot.visualType,
            sourceKind: shot.sourceKind,
            modelClass: shot.modelClass,
            providerKey: providerKeyFor(shot.sourceKind, shot.modelClass),
            takesWanted: shot.takesWanted,
            round: shot.round,
          },
          ["plan"],
          hints,
        );
      }
      shot.hints = [];
    }
  }

  for (const shot of shots) {
    if (shot.status === "replanning" && !shot.replanQueued) {
      shot.replanQueued = true;
      add("plan", shot.shotId, { directive: "downgrade", shotId: shot.shotId, visualType: shot.visualType, downgradeTo: shot.downgradeTo }, ["validated", "dna", "voice", "plan"], []);
    }
  }

  for (const take of Object.values(state.takes).sort((a, b) => a.takeId.localeCompare(b.takeId))) {
    if (take.verdict === null && !take.checkQueued) {
      take.checkQueued = true;
      add("check_take", take.takeId, { shotId: take.shotId, takeId: take.takeId }, [`take:${take.takeId}`], []);
    }
  }

  for (const branch of Object.values(state.branches).sort((a, b) => a.edlId.localeCompare(b.edlId))) {
    if (branch.status !== "running" || branch.queued || branch.stage === "done") continue;
    branch.queued = true;
    const hints = branch.hints;
    branch.hints = [];
    add(branch.stage, branch.edlId, { edlId: branch.edlId, variantOf: branch.variantOf }, branchSlots(branch), hints);
  }

  return jobs;
}

function nodeDetails(state: OrchestratorState, node: SingleNode): Record<string, unknown> {
  if (node === "variants") return { masterEdlId: state.masterEdlId, variantCount: state.variantCount };
  return {};
}
