// Pure orchestrator core (Video Engine Bible 3, 5.1 to 5.3, 6.1 to 6.14). advance(state, event) applies one event and
// returns the jobs that are now ready, the effects to persist and the next state. It does no I/O and reads no clock, so a
// replay of the same state and event gives the same jobs with the same idempotency keys.
//
// Scheduling is state-driven: after an event is applied, every node whose inputs are ready and that is not yet queued is
// queued. A paused request queues nothing until it is resumed. Results that arrive while paused are still recorded.

import { EngineError } from "../contracts/index.ts";
import type { EngineEvent, StageOutput } from "./types.ts";
import { ORCHESTRATOR_STATE_SCHEMA, CHAIN_STAGES, orchestratorLimits, invalid, conflict, checkGate, pauseWith, isCurrent, runOfProduce, runOfTake, variantRunOfDead, isSingleNode } from "./orchestrator-state.ts";
import type { NodeState, OrchestratorState, EngineEffect, AdvanceResult } from "./orchestrator-state.ts";
import { applyIntake, applyWriteScript, applySingleGate, applyPlan, applyEstimate, applyDeliver } from "./orchestrator-single.ts";
import { applyProduce, applyCheck } from "./orchestrator-shots.ts";
import { applyEdit, applyCompose, applyPreRender, applyRender, applyPostRender, escalateBranch } from "./orchestrator-branch.ts";
import { applyVariants, applyVariantPhase, applyVariantProduce, applyVariantCheck, applyVariantDead, settleVariantAssembly, applyVariantAssembly } from "./orchestrator-variants.ts";
import { applyRemake } from "./orchestrator-remake.ts";
import { schedule } from "./orchestrator-schedule.ts";

export { ORCHESTRATOR_STATE_SCHEMA, SINGLE_NODES, orchestratorLimits, providerKeyFor, needsProduce } from "./orchestrator-state.ts";
export type { SingleNode, BranchStage, ShotState, TakeVerdictState, TakeState, BranchState, Pause, OrchestratorState, EngineEffect, AdvanceResult } from "./orchestrator-state.ts";
export { remakeRefusalOf } from "./orchestrator-remake.ts";

function initialState(event: Extract<EngineEvent, { type: "start" }>): OrchestratorState {
  if (!Number.isInteger(event.variantCount) || event.variantCount < 0) {
    invalid("variantCount must be a whole number of zero or more");
  }
  const idle = (): NodeState => ({ status: "idle", redos: 0, hints: [] });
  // A script request skips write_script as done (contract v8). A brief waits for it, after analysis.
  const writeScript: NodeState = event.brief === true ? idle() : { status: "passed", redos: 0, hints: [] };
  const nodes: OrchestratorState["nodes"] = {
    intake: idle(),
    analyze_reference: idle(),
    write_script: writeScript,
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
  // A delivered request accepts one kind of event: a person remaking a shot, which starts its next revision (Bible 5.5).
  if (current.status === "rejected" || (current.status === "delivered" && event.type !== "remake")) {
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
    case "remake":
      applyRemake(state, event, effects);
      break;
  }
  settleVariantAssembly(state, effects);
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
    case "write_script":
      return applyWriteScript(state, output);
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
      if (output.phase === "assemble") return applyVariantAssembly(state, output, effects);
      return applyVariantPhase(state, output, effects);
    case "deliver":
      return applyDeliver(state, output, effects);
  }
}

/**
 * A job exhausted its attempts (Bible 5.1, 15.5). The stage it ran goes back to not-in-flight so a resume re-queues it,
 * and the request pauses with its artifacts intact.
 */
function applyDead(state: OrchestratorState, event: Extract<EngineEvent, { type: "dead" }>, effects: EngineEffect[]): void {
  const { stage, subjectId, reason } = event;
  const variant = variantRunOfDead(state, stage, subjectId);
  if (variant !== null) return applyVariantDead(variant, event, effects);
  // A dead job of a generation variant's chain (or of a caption or music chain) ends that chain, not the request (Bible 6.13).
  const chain = (CHAIN_STAGES as readonly string[]).includes(stage) ? state.branches[subjectId] : undefined;
  if (chain !== undefined && chain.variantOf !== null) {
    if (!chain.queued) conflict(`${stage} for ${subjectId} is not in flight`, stage);
    return escalateBranch(state, chain, `${stage} for ${subjectId} died: ${reason}`, effects);
  }
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
