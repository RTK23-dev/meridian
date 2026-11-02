// The branch results of the orchestrator: edit, compose, the pre-render and post-render reviews, and the revisions. Moved out
// of engine/jobs/orchestrator.ts unchanged (coding loop, T7). orchestrator.ts dispatches to them.

import type { GateResult } from "../contracts/index.ts";
import { gateReviewItem } from "../review/inbox.ts";
import type { StageOutput } from "./types.ts";
import { failVariantRun, isTerminal, passVariantRun } from "./variant-runs.ts";
import { orchestratorLimits, invalid, needsProduce, failingRules, mergeArtifacts, expectQueued, pauseWith, newBranch, expectBranch, verdictOf, artifactWithPrefix, runOfBranch, endedRun, branchStageName, failingShotIds, supersedeBranch } from "./orchestrator-state.ts";
import type { BranchStage, BranchState, OrchestratorState, EngineEffect } from "./orchestrator-state.ts";
import { failNode } from "./orchestrator-single.ts";
import { downgradeOrEscalate } from "./orchestrator-shots.ts";

export function applyEdit(state: OrchestratorState, output: Extract<StageOutput, { stage: "edit" }>, effects: EngineEffect[]): void {
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

export function applyCompose(state: OrchestratorState, output: Extract<StageOutput, { stage: "compose" }>): void {
  const branch = expectBranch(state, output.edlId, "compose", "compose");
  if (output.subjectId !== output.edlId) invalid("compose must report for its EDL", "compose");
  mergeArtifacts(state, output.artifacts);
  branch.queued = false;
  branch.hints = [];
  branch.stage = "pre_render_gate";
}

/** The gold metrics of this request, by check key (Bible 12.4). Absent metrics are unproven, so a failure of them is reviewed. */

export function applyPreRender(state: OrchestratorState, output: Extract<StageOutput, { stage: "pre_render_gate" }>, effects: EngineEffect[]): void {
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
  // A variant's chain never revises the master's shots or the master's edit: its failure is its own (Bible 6.13).
  if (branch.variantOf !== null) {
    retryBranchStage(state, branch, "pre_render_gate", output.gate, effects, "the pre-render gate failed");
    return;
  }
  const shots = failingShotIds(state, output.gate);
  if (shots.length > 0) {
    reviseFromShots(state, branch, shots, output.gate, effects);
    return;
  }
  reviseEdit(state, branch, output.gate, effects, "the pre-render gate failed");
}

export function applyRender(state: OrchestratorState, output: Extract<StageOutput, { stage: "render" }>, effects: EngineEffect[]): void {
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

export function applyPostRender(state: OrchestratorState, output: Extract<StageOutput, { stage: "post_render_review" }>, effects: EngineEffect[]): void {
  const branch = expectBranch(state, output.edlId, "post_render_review", "post_render_review");
  mergeArtifacts(state, output.artifacts);
  branch.queued = false;
  if (output.gate.pass) {
    branch.stage = "done";
    branch.status = "passed";
    branch.hints = [];
    const run = runOfBranch(state, branch);
    if (run !== null) {
      const before = isTerminal(run);
      passVariantRun(run);
      endedRun(before, run, effects);
    }
    return;
  }
  if (verdictOf(state, output.gate) === "review") {
    reviewBranch(state, branch, output.gate, artifactWithPrefix(output.artifacts, "review:"), effects);
    return;
  }
  const shots = failingShotIds(state, output.gate);
  if (shots.length > 0 && branch.variantOf === null) {
    reviseFromShots(state, branch, shots, output.gate, effects);
    return;
  }
  retryBranchStage(state, branch, "compose", output.gate, effects, `post-render review failed after ${orchestratorLimits.stageRedos} redos`);
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

export function escalateBranch(
  state: OrchestratorState,
  branch: BranchState,
  reason: string,
  effects: EngineEffect[],
  extra: Record<string, unknown> = {},
): void {
  branch.status = "escalated";
  branch.queued = false;
  // A generation variant's chain that escalates fails that variant alone: the request is not paused, and the master is not revised.
  const run = runOfBranch(state, branch);
  if (run !== null) {
    const before = isTerminal(run);
    failVariantRun(run, reason);
    endedRun(before, run, effects);
  }
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
