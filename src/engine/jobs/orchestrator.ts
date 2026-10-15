// Pure orchestrator core (Video Engine Bible 3, 5.1 to 5.3, 6.1 to 6.14). advance(state, event) applies one event and
// returns the jobs that are now ready, the effects to persist and the next state. It does no I/O and reads no clock, so a
// replay of the same state and event gives the same jobs with the same idempotency keys.
//
// Scheduling is state-driven: after an event is applied, every node whose inputs are ready and that is not yet queued is
// queued. A paused request queues nothing until it is resumed. Results that arrive while paused are still recorded.

import { EngineError, type Decision, type GateId, type GateResult, type ModelClass, type TakeVerdict } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { decideGate, type GateVerdict, type GoldMetrics } from "../review/gold.ts";
import { gateReviewItem, takeReviewItem } from "../review/inbox.ts";
import { STAGE_SPECS, engineJobKey, priorityNumber, type EngineStage } from "./registry.ts";
import { jobSettings, type RequestPriority } from "./settings.ts";
import type { EngineEvent, EnginePayload, ProduceHold, QueuedJob, ShotSourceKind, ShotSummary, StageOutput } from "./types.ts";
import { nextPhaseOf } from "../variants/work.ts";
import {
  applyPlanOutcome,
  applyProduceResult,
  applyVerdict,
  applyVoiceOutcome,
  applyWriterOutcome,
  failVariantRun,
  isTerminal,
  markIssued,
  newVariantRun,
  shotsToIssue,
  takesToCheck,
  variantDecision,
  type VariantRun,
} from "./variant-runs.ts";

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
  /** The plan epoch: 0 for the first plan, one more for every replan. A result of an older epoch is recorded, never counted (5.3). */
  epoch: number;
  /** Prompt rewrites this shot has used (Bible 10.4). */
  rewrites: number;
  /** What the next plan job asks for: a downgrade (Bible 5.3) or a prompt rewrite (Bible 10.4), with its rule-name hints. */
  replanDirective: "downgrade" | "rewrite";
  replanHints: string[];
};

export type TakeVerdictState = {
  /** The verdict as check_take returned it. The review item is built from it. */
  verdict: TakeVerdict;
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
  /** The plan epoch the take was made in. */
  epoch: number;
  /** A take made for a plan that has since been replaced. It is kept on record and never checked or counted. */
  stale: boolean;
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
  /**
   * The gold metrics this request's gates are judged by, by check key ("gate:rule"), as they were when the request started (Bible
   * 12.4). A check whose metrics do not meet the target cannot block: its failure goes to review. Absent in states written before
   * E4, which reads as no proven check.
   */
  gateMetrics?: Record<string, GoldMetrics>;
  /**
   * The generation variants, by key (Bible 6.13). Each run has its own phases, shots and takes, and fails alone. Absent in states written
   * before the variant work list, which reads as no run.
   */
  variantRuns?: Record<string, VariantRun>;
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
  /** Prompt rewrites a refused shot gets before it is downgraded (Bible 10.4). */
  promptRewrites: jobSettings.promptRewrites,
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
    gateMetrics: { ...(event.gateMetrics ?? {}) },
    variantRuns: {},
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
    case "produce_shot": {
      const run = runOfProduce(state, output.subjectId);
      if (run !== null) return applyVariantProduce(run, output, effects);
      return applyProduce(state, output, effects);
    }
    case "check_take": {
      const run = runOfTake(state, output.takeId);
      if (run !== null) return applyVariantCheck(run, output, effects);
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyCheck(state, output, effects);
    }
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
      for (const decision of output.decisions ?? []) effects.push({ kind: "decision", decision });
      return applyRender(state, output, effects);
    case "post_render_review":
      checkGate(output.stage, output.gate);
      effects.push({ kind: "gate", gate: output.gate });
      return applyPostRender(state, output, effects);
    case "variants":
      if (output.phase === "request") return applyVariants(state, output);
      return applyVariantPhase(state, output, effects);
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

/**
 * A passing intake advances the request and keeps its pre-flight hold as the request's reservation (Bible 6.1 step 8, E3 lead
 * decision 1). A pass with no reservation is still accepted, and schedule() then pauses the request at the first paid stage,
 * naming it, so no paid call runs unfunded.
 */
function applyIntake(state: OrchestratorState, output: Extract<StageOutput, { stage: "intake" }>, effects: EngineEffect[]): void {
  expectQueued(state, "intake", output.subjectId);
  mergeArtifacts(state, output.artifacts);
  // The pre-flight hold was paused or refused: nothing is spent, the request waits for budget, and a resume runs intake again.
  if (output.budgetPause !== null) {
    state.nodes.intake.status = "idle";
    pauseWith(state, { kind: "budget", stage: "intake", subjectId: state.requestId, reason: `Budget: ${output.budgetPause}` });
    return;
  }
  if (!output.gate.pass) {
    state.nodes.intake.status = "idle";
    state.status = "rejected";
    effects.push({ kind: "rejected", reasons: reasonsOf(output.gate) });
    return;
  }
  state.nodes.intake.status = "passed";
  if (output.budgetReservationId !== null) state.budgetReservationId = output.budgetReservationId;
  if (state.cachedDna) state.nodes.analyze_reference.status = "passed";
}

/** The reason a paid stage pauses the request when no reservation exists yet (Bible 5.1, 14). Names the stage. */
function unfundedReason(stage: EngineStage): string {
  return (
    `${stage} is a paid stage and needs a budget reservation on the request, and none exists yet. Intake does not reserve, ` +
    "and estimate_reserve runs after the plan (Bible 5.1, 6.1, 14). No paid call is queued."
  );
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

/** A shot as a plan states it. A replan (previous given) starts a new epoch and keeps the shot's own counts. */
function shotFromSummary(summary: ShotSummary, previous: ShotState | null): ShotState {
  return {
    ...summary,
    status: needsProduce(summary.sourceKind) ? "pending" : "accepted",
    round: 0,
    issued: 0,
    replanQueued: false,
    replanFailed: false,
    hints: [],
    acceptedTakeId: null,
    downgrades: previous?.downgrades ?? 0,
    epoch: previous === null ? 0 : previous.epoch + 1,
    rewrites: previous?.rewrites ?? 0,
    replanDirective: "downgrade",
    replanHints: [],
  };
}

function startReplan(shot: ShotState, directive: "downgrade" | "rewrite", hints: string[]): void {
  shot.status = "replanning";
  shot.replanQueued = false;
  shot.replanDirective = directive;
  shot.replanHints = hints;
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
    for (const summary of output.shots) state.shots[summary.shotId] = shotFromSummary(summary, null);
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
  state.shots[shot.shotId] = shotFromSummary(summary, shot);
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

function applyProduce(state: OrchestratorState, output: Extract<StageOutput, { stage: "produce_shot" }>, effects: EngineEffect[]): void {
  const shot = state.shots[output.shotId];
  if (!shot) conflict(`shot ${output.shotId} is not in the plan`, "produce_shot");
  if (output.subjectId !== output.shotId) invalid("produce_shot must report for its own shot", "produce_shot");
  for (const decision of output.decisions ?? []) effects.push({ kind: "decision", decision });
  const current = output.epoch === shot.epoch && shot.status === "pending";

  if (output.hold !== undefined) {
    if (output.takeId !== null) invalid("a produce result cannot hold and make a take at once", "produce_shot");
    // A hold from an older plan is the replanned shot's past; it changes nothing.
    if (current) applyHold(state, shot, output.hold, effects);
    return;
  }
  if (output.takeId === null) invalid("a produce result with no take must say why it made none", "produce_shot");
  if (state.takes[output.takeId]) conflict(`take ${output.takeId} was already recorded`, "produce_shot");
  mergeArtifacts(state, output.artifacts);
  state.takes[output.takeId] = {
    takeId: output.takeId,
    shotId: output.shotId,
    round: shot.round,
    epoch: output.epoch,
    stale: !current,
    checkQueued: false,
    verdict: null,
  };
}

/**
 * A produce job that made no take. A budget hold pauses the request, and resume queues the job again. A refusal goes back to the
 * planner once for a prompt rewrite (Bible 10.4), and a shot refused after the rewrite is downgraded or escalated.
 */
function applyHold(state: OrchestratorState, shot: ShotState, hold: ProduceHold, effects: EngineEffect[]): void {
  shot.issued = Math.max(0, shot.issued - 1);
  if (hold.kind === "budget") {
    pauseWith(state, { kind: "budget", stage: "produce_shot", subjectId: shot.shotId, reason: hold.reason });
    return;
  }
  if (shot.rewrites < orchestratorLimits.promptRewrites) {
    shot.rewrites += 1;
    startReplan(shot, "rewrite", [hold.hint]);
    effects.push({
      kind: "decision",
      decision: {
        at: `shot:${shot.shotId}`,
        chose: "prompt_rewrite",
        alternatives: [],
        reason: `the provider refused ${shot.shotId} (${hold.errorKind}); the planner rewrites its prompt once (Video Engine Bible 10.4)`,
        by: "scorer",
      },
    });
    return;
  }
  downgradeOrEscalate(state, shot, `the provider refused ${shot.shotId} (${hold.errorKind}) after its prompt rewrite`, effects);
}

/** Records a verdict. A verdict for a take of a replaced plan is kept on record and not counted (Bible 5.3). */
function applyCheck(state: OrchestratorState, output: Extract<StageOutput, { stage: "check_take" }>, effects: EngineEffect[]): void {
  const take = state.takes[output.takeId];
  if (!take || take.verdict !== null) conflict(`take ${output.takeId} is not waiting for a verdict`, "check_take");
  if (take.shotId !== output.shotId || output.subjectId !== output.takeId) invalid("check_take reports for another shot or take", "check_take");
  if (output.gate.pass !== output.verdict.pass) invalid("the take gate and the verdict disagree", "check_take");
  mergeArtifacts(state, output.artifacts);
  take.verdict = {
    verdict: output.verdict,
    pass: output.verdict.pass,
    confidence: output.verdict.confidence,
    failing: verdictRules(output.verdict),
    criticEscalates: output.verdict.action === "escalate",
    verdictArtifactId: output.artifacts[`verdict:${output.takeId}`] ?? null,
  };
  const shot = state.shots[take.shotId];
  if (shot && isCurrent(state, take)) resolveRound(state, shot, effects);
}

/** A take counts for its shot only while it belongs to the shot's current plan and the shot is still producing. */
function isCurrent(state: OrchestratorState, take: TakeState): boolean {
  const shot = state.shots[take.shotId];
  return shot !== undefined && !take.stale && take.epoch === shot.epoch && shot.status === "pending";
}

/** Once every take of the current round has a verdict, act on the round (Bible 5.3). */
function resolveRound(state: OrchestratorState, shot: ShotState, effects: EngineEffect[]): void {
  const round = takesOf(state, shot.shotId, shot.round, shot.epoch);
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

function takesOf(state: OrchestratorState, shotId: string, round: number, epoch: number): TakeState[] {
  return Object.values(state.takes)
    .filter((take) => take.shotId === shotId && take.round === round && take.epoch === epoch && !take.stale)
    .sort((a, b) => a.takeId.localeCompare(b.takeId));
}

function downgradeOrEscalate(state: OrchestratorState, shot: ShotState, why: string, effects: EngineEffect[]): void {
  if (shot.downgradeTo !== null) {
    startReplan(shot, "downgrade", []);
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
  // The review-inbox payload (Bible 12.5), built from the verdicts check_take returned. A shot with no verdict yet has no payload.
  const judged = takes.flatMap((take) => (take.verdict === null ? [] : [{ take, verdict: take.verdict.verdict }]));
  const review =
    judged.length === 0
      ? null
      : takeReviewItem({
          requestId: state.requestId,
          shotId: shot.shotId,
          visualType: shot.visualType,
          reason,
          planArtifactId: state.artifacts.plan ?? null,
          takes: judged.map(({ take, verdict }) => ({
            takeId: take.takeId,
            takeArtifactId: state.artifacts[`take:${take.takeId}`] ?? null,
            verdictArtifactId: take.verdict?.verdictArtifactId ?? null,
            verdict,
          })),
        });
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
      ...(review === null ? {} : { review }),
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

/** The gold metrics of this request, by check key (Bible 12.4). Absent metrics are unproven, so a failure of them is reviewed. */
function metricsOf(state: OrchestratorState): Record<string, GoldMetrics | undefined> {
  return state.gateMetrics ?? {};
}

/** How a failed gate routes (Bible 5.3, 12.4): block when a failing check is proven, review when none is. Pure. */
function verdictOf(state: OrchestratorState, gate: GateResult): GateVerdict {
  return decideGate(gate, metricsOf(state)).verdict;
}

/** The first artifact of a slot family ("integrity:", "review:"), or null. Stage outputs name their artifacts by slot. */
function artifactWithPrefix(artifacts: Record<string, string>, prefix: string): string | null {
  return Object.entries(artifacts).find(([slot]) => slot.startsWith(prefix))?.[1] ?? null;
}

/**
 * A gate failure that no proven check explains goes to human review, not to a redo (Bible 5.3, 12.4). The branch escalates with a
 * gate review item (meridian.gate_review/v1) for pre_render and post_render; render integrity has no such item and carries its rules.
 */
function reviewBranch(state: OrchestratorState, branch: BranchState, gate: GateResult, resultArtifactId: string | null, effects: EngineEffect[]): void {
  const reason = `${gate.gate} failed without a proven gold set: ${failingRules(gate).join(", ") || "no failing check"}`;
  const gateReview =
    gate.gate === "pre_render" || gate.gate === "post_render"
      ? gateReviewItem({
          requestId: state.requestId,
          gate: { gate: gate.gate, subjectId: gate.subjectId, checks: gate.checks, failingShotIds: gate.failingShotIds },
          resultArtifactId,
          failures: [],
        })
      : null;
  escalateBranch(state, branch, reason, effects, { gate: gate.gate, rules: failingRules(gate), ...(gateReview ? { gateReview } : {}) });
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
  if (verdictOf(state, output.gate) === "review") {
    reviewBranch(state, branch, output.gate, artifactWithPrefix(output.artifacts, "gate:"), effects);
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
  if (verdictOf(state, output.gate) === "review") {
    reviewBranch(state, branch, output.gate, artifactWithPrefix(output.artifacts, "integrity:"), effects);
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
  if (verdictOf(state, output.gate) === "review") {
    reviewBranch(state, branch, output.gate, artifactWithPrefix(output.artifacts, "review:"), effects);
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

function escalateBranch(
  state: OrchestratorState,
  branch: BranchState,
  reason: string,
  effects: EngineEffect[],
  extra: Record<string, unknown> = {},
): void {
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
    detail: { edlId: branch.edlId, variantOf: branch.variantOf, stage: branch.stage, ...extra },
  });
}

function branchStageName(stage: BranchStage): EngineStage {
  return stage === "done" ? "post_render_review" : stage;
}

/**
 * The request phase of the variants stage (Bible 6.13). Its EDLs (caption and music) become branches. Its work list starts one run for
 * each generation variant, and the runs are queued by schedule(). A variant's plan and voice are its own: they stay in its run, not in
 * the request's artifacts, since deliver reads every request artifact and needs exactly one scene plan (handlers/deliver.ts).
 */
function applyVariants(state: OrchestratorState, output: Extract<StageOutput, { stage: "variants"; phase: "request" }>): void {
  expectQueued(state, "variants", output.subjectId);
  if (state.masterEdlId === null) conflict("variants ran without a master EDL", "variants");
  mergeArtifacts(
    state,
    Object.fromEntries(Object.entries(output.artifacts).filter(([slot]) => slot.startsWith("edl:"))),
  );
  for (const variant of output.variants) {
    if (state.branches[variant.edlId]) invalid(`variant ${variant.edlId} already has a branch`, "variants");
    state.branches[variant.edlId] = newBranch(variant.edlId, state.masterEdlId);
  }
  const runs = variantRunsOf(state);
  for (const item of output.work) {
    if (runs[item.key] || Object.values(runs).some((run) => run.subject === item.subject)) {
      invalid(`variant ${item.key} is already in the variant work list`, "variants");
    }
    runs[item.key] = newVariantRun(item);
  }
  state.variantRuns = runs;
  state.nodes.variants.status = "passed";
}

// --- Variant runs (Bible 6.13) -------------------------------------------------------------------------------------------------------
// A run's phases, produce jobs and checks are queued by schedule() and applied here. A run never pauses the request. Its end is a
// decision in the manifest (variantDecision), so a produced or failed variant is on record with its reason.

function variantRunsOf(state: OrchestratorState): Record<string, VariantRun> {
  return state.variantRuns ?? {};
}

/** The run that owns a produce job's subject: one of its shots' subjects. Null for a master produce job. */
function runOfProduce(state: OrchestratorState, subjectId: string): VariantRun | null {
  return Object.values(variantRunsOf(state)).find((run) => Object.values(run.shots).some((shot) => shot.subject === subjectId)) ?? null;
}

/** The run that owns a take: the run that made it. Null for a master take. */
function runOfTake(state: OrchestratorState, takeId: string): VariantRun | null {
  return Object.values(variantRunsOf(state)).find((run) => run.takes[takeId] !== undefined) ?? null;
}

/** Records a decision once, when a run ends (produced or failed). */
function endedRun(before: boolean, run: VariantRun, effects: EngineEffect[]): void {
  if (!before && isTerminal(run)) effects.push({ kind: "decision", decision: variantDecision(run) });
}

function applyVariantPhase(state: OrchestratorState, output: Extract<StageOutput, { stage: "variants"; phase: "writer" | "voice" | "plan" }>, effects: EngineEffect[]): void {
  const run = variantRunsOf(state)[output.key];
  if (!run || run.subject !== output.subjectId) invalid(`variant ${output.key} is not in the variant work list`, "variants");
  if (run.phase !== output.phase) conflict(`variant ${output.key} is not waiting for its ${output.phase} phase`, "variants");
  const before = isTerminal(run);
  if (output.phase === "writer") applyWriterOutcome(run, output.outcome);
  else if (output.phase === "voice") applyVoiceOutcome(run, output.outcome);
  else applyPlanOutcome(run, output.outcome);
  endedRun(before, run, effects);
}

function holdTextOf(output: Extract<StageOutput, { stage: "produce_shot" }>): string | null {
  if (output.hold === undefined) return null;
  if (output.hold.kind === "budget") return `the budget held shot ${output.shotId}: ${output.hold.reason}`;
  return `the provider refused shot ${output.shotId} (${output.hold.errorKind})`;
}

function applyVariantProduce(run: VariantRun, output: Extract<StageOutput, { stage: "produce_shot" }>, effects: EngineEffect[]): void {
  const before = isTerminal(run);
  for (const decision of output.decisions ?? []) effects.push({ kind: "decision", decision });
  const takeSlot = output.takeId === null ? null : `take:${output.takeId}`;
  const takeArtifactId = takeSlot === null ? null : (output.artifacts[takeSlot] ?? null);
  applyProduceResult(run, { shotId: output.shotId, takeId: output.takeId, takeArtifactId, held: holdTextOf(output) });
  if (takeSlot !== null && takeArtifactId !== null) run.artifacts[takeSlot] = takeArtifactId;
  endedRun(before, run, effects);
}

function applyVariantCheck(run: VariantRun, output: Extract<StageOutput, { stage: "check_take" }>, effects: EngineEffect[]): void {
  const before = isTerminal(run);
  if (output.gate.pass !== output.verdict.pass) invalid("the take gate and the verdict disagree", "check_take");
  applyVerdict(run, { takeId: output.takeId, verdict: output.verdict, redosPerShot: orchestratorLimits.shotRedos });
  const verdictArtifact = output.artifacts[`verdict:${output.takeId}`];
  if (verdictArtifact) run.artifacts[`verdict:${output.takeId}`] = verdictArtifact;
  endedRun(before, run, effects);
}

/** A dead job of a variant ends that variant alone. A job of a run that has ended changes nothing. */
function applyVariantDead(run: VariantRun, event: Extract<EngineEvent, { type: "dead" }>, effects: EngineEffect[]): void {
  const before = isTerminal(run);
  failVariantRun(run, `${event.stage} for ${event.subjectId} died: ${event.reason}`);
  endedRun(before, run, effects);
}

/** The run a dead job belongs to, or null for a master job. A variant's phase, produce and check jobs are its own. */
function variantRunOfDead(state: OrchestratorState, stage: EngineStage, subjectId: string): VariantRun | null {
  if (stage === "variants") return Object.values(variantRunsOf(state)).find((run) => run.subject === subjectId) ?? null;
  if (stage === "produce_shot") return runOfProduce(state, subjectId);
  if (stage === "check_take") return runOfTake(state, subjectId);
  return null;
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
  const variant = variantRunOfDead(state, stage, subjectId);
  if (variant !== null) return applyVariantDead(variant, event, effects);
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
    if (!shot) conflict(`produce for ${subjectId} is not in flight`, stage);
    // A job of an older plan, or of a shot that has moved on, is not in flight any more: its death changes nothing.
    if (shot.status !== "pending" || (event.epoch !== undefined && event.epoch !== shot.epoch)) return;
    if (shot.issued === 0) conflict(`produce for ${subjectId} is not in flight`, stage);
    shot.issued -= 1;
  } else if (stage === "check_take") {
    const take = state.takes[subjectId];
    if (!take || !take.checkQueued || take.verdict !== null) conflict(`check for ${subjectId} is not in flight`, stage);
    take.checkQueued = false;
    if (!isCurrent(state, take)) return;
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

/** Delivery waits for every variant EDL's chain and every generation variant's run to end (a produced or a failed run). */
function variantsSettled(state: OrchestratorState): boolean {
  const branchesDone = Object.values(state.branches).every((branch) => branch.variantOf === null || branch.status !== "running");
  return branchesDone && Object.values(variantRunsOf(state)).every(isTerminal);
}

/** The accepted take of every shot, as slots. Pre-render and the edit read them (Bible 6.10). */
function acceptedTakeSlots(state: OrchestratorState): string[] {
  return Object.values(state.shots).flatMap((shot) => (shot.acceptedTakeId ? [`take:${shot.acceptedTakeId}`] : []));
}

/**
 * The artifact slots a branch stage reads (Bible 6.9 to 6.12). The render stage reads the validated request for the style kit; the
 * pre-render gate reads every input its checks need, and the post-render review reads the render's integrity result.
 */
function branchSlots(state: OrchestratorState, branch: BranchState): string[] {
  const edl = `edl:${branch.edlId}`;
  switch (branch.stage) {
    case "compose":
      return [edl, "validated"];
    case "pre_render_gate":
      return [`composition:${branch.edlId}`, edl, "plan", "validated", "voice", "dna", ...acceptedTakeSlots(state)];
    case "render":
      return [`composition:${branch.edlId}`, edl, "validated"];
    case "post_render_review":
      return [`render:${branch.edlId}`, `integrity:${branch.edlId}`, edl];
    case "done":
      return [];
  }
}

/** Queue every job that is ready and not yet queued. Mutates the state it is given (the caller passes a copy). */
function schedule(state: OrchestratorState): QueuedJob[] {
  if (state.status !== "running") return [];
  const jobs: QueuedJob[] = [];

  /** Queues one job. Its inputs are the request's slots, or the artifact ids a variant run names (explicitIds), never both. */
  const add = (
    stage: EngineStage,
    subjectId: string,
    details: Record<string, unknown>,
    slots: string[],
    hints: string[],
    explicitIds?: (string | undefined)[],
  ): void => {
    const spec = STAGE_SPECS[stage];
    if (spec.paid && state.budgetReservationId === null) {
      throw new EngineError("invalid_input", `${stage} is a paid stage and needs a budget reservation on the request (Bible 14)`, { stage });
    }
    const attempt = nextAttempt(state, stage, subjectId);
    const resolved = explicitIds ?? slots.map((slot) => state.artifacts[slot]);
    const inputArtifactIds = [...new Set(resolved.filter((id): id is string => id !== undefined))];
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
  // A paid stage that is ready but has no reservation on the request is not queued. The request pauses on budget, naming it.
  // This keeps every paid call on a reservation (Bible 5.1, 14). See unfundedReason.
  if (state.budgetReservationId === null) {
    const unfunded = SINGLE_NODES.find((node) => n[node].status === "idle" && ready[node] && STAGE_SPECS[node].paid);
    if (unfunded !== undefined) {
      pauseWith(state, { kind: "budget", stage: unfunded, subjectId: state.requestId, reason: unfundedReason(unfunded) });
      return [];
    }
  }

  const nodeSlots: Record<SingleNode, string[]> = {
    intake: ["request"],
    analyze_reference: ["request"],
    voice: ["request"],
    plan: ["validated", "dna", "voice"],
    // The request artifact carries the request's budget (constraints.budgetUsd), which the reservation needs (Bible 14.1).
    estimate_reserve: ["plan", "request"],
    // The validated request names the style kit and carries the emphasis marks the editor reads (E3, edit/STATUS.md item 1).
    edit: ["plan", "dna", "voice", "validated", ...Object.values(state.shots).flatMap((shot) => (shot.acceptedTakeId ? [`take:${shot.acceptedTakeId}`] : []))],
    // The variants stage expands the request's matrix against its plan and its master (Bible 6.13).
    variants: state.masterEdlId === null ? [] : [`edl:${state.masterEdlId}`, "request", "plan"],
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
            epoch: shot.epoch,
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
      add(
        "plan",
        shot.shotId,
        { directive: shot.replanDirective, shotId: shot.shotId, visualType: shot.visualType, downgradeTo: shot.downgradeTo },
        ["validated", "dna", "voice", "plan"],
        shot.replanHints,
      );
    }
  }

  for (const take of Object.values(state.takes).sort((a, b) => a.takeId.localeCompare(b.takeId))) {
    if (take.verdict !== null || take.checkQueued || take.stale) continue;
    const owner = state.shots[take.shotId];
    if (!owner || owner.epoch !== take.epoch) continue;
    take.checkQueued = true;
    add("check_take", take.takeId, { shotId: take.shotId, takeId: take.takeId, epoch: take.epoch }, [`take:${take.takeId}`, "plan"], []);
  }

  // Generation variants (Bible 6.13). A run queues its next phase (writer, voice, plan), then the produce job of each shot it changes, then
  // the check of each take. Its subjects and attempts are its own, so no job key is shared with the master or with another variant.
  for (const run of Object.values(variantRunsOf(state)).sort((a, b) => a.key.localeCompare(b.key))) {
    if (run.status === "preparing" && run.phase === null) {
      const phase = nextPhaseOf(run.work, run.done);
      if (phase !== null) {
        run.phase = phase;
        add(
          "variants",
          run.subject,
          { phase, variantKey: run.key, masterEdlId: state.masterEdlId, work: run.work, text: run.text, voiceTrackId: run.voiceTrackId },
          ["request", "plan"],
          [],
        );
      }
    }
    for (const shot of shotsToIssue(run)) {
      while (shot.issued < shot.takesWanted) {
        const hints = markIssued(run, shot.shotId);
        add(
          "produce_shot",
          shot.subject,
          {
            shotId: shot.shotId,
            variantKey: run.key,
            visualType: shot.visualType,
            sourceKind: "generate",
            modelClass: shot.modelClass,
            providerKey: providerKeyFor("generate", shot.modelClass),
            takesWanted: shot.takesWanted,
            round: shot.round,
          },
          [],
          hints,
          [run.artifacts[`plan:${run.key}`]],
        );
      }
    }
    for (const take of takesToCheck(run)) {
      take.checkQueued = true;
      add("check_take", take.takeId, { shotId: take.shotId, takeId: take.takeId, variantKey: run.key }, [], [], [take.artifactId ?? undefined, run.artifacts[`plan:${run.key}`]]);
    }
  }

  for (const branch of Object.values(state.branches).sort((a, b) => a.edlId.localeCompare(b.edlId))) {
    if (branch.status !== "running" || branch.queued || branch.stage === "done") continue;
    branch.queued = true;
    const hints = branch.hints;
    branch.hints = [];
    add(branch.stage, branch.edlId, { edlId: branch.edlId, variantOf: branch.variantOf }, branchSlots(state, branch), hints);
  }

  return jobs;
}

function nodeDetails(state: OrchestratorState, node: SingleNode): Record<string, unknown> {
  if (node === "variants") return { masterEdlId: state.masterEdlId, variantCount: state.variantCount };
  return {};
}
