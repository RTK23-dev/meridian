// The single-node results of the orchestrator: intake, the script, the plan, the estimate, the gates and delivery. Moved out
// of engine/jobs/orchestrator.ts unchanged (coding loop, T7). orchestrator.ts dispatches to them.

import type { GateResult } from "../contracts/index.ts";
import type { EngineStage } from "./registry.ts";
import type { StageOutput } from "./types.ts";
import { orchestratorLimits, invalid, conflict, failingRules, reasonsOf, mergeArtifacts, expectQueued, pauseWith, escalateRequest } from "./orchestrator-state.ts";
import type { SingleNode, OrchestratorState, EngineEffect } from "./orchestrator-state.ts";
import { shotFromSummary, escalateShot } from "./orchestrator-shots.ts";

/**
 * A passing intake advances the request and keeps its pre-flight hold as the request's reservation (Bible 6.1 step 8, E3 lead
 * decision 1). A pass with no reservation is still accepted, and schedule() then pauses the request at the first paid stage,
 * naming it, so no paid call runs unfunded.
 */
export function applyIntake(state: OrchestratorState, output: Extract<StageOutput, { stage: "intake" }>, effects: EngineEffect[]): void {
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
  // Intake reused a stored VideoDNA: its dna slot names the copy, so analyze_reference is not queued (Bible 6.1 step 5).
  if (output.artifacts.dna !== undefined) state.cachedDna = true;
  if (state.cachedDna) state.nodes.analyze_reference.status = "passed";
}

/**
 * The written script of a brief passed (contract v8). Its artifact is the request's "script" slot, which voice, plan, edit, the pre-render
 * gate and the variants read. A write_script that passes names the script it wrote; without it the stage did not pass.
 */
export function applyWriteScript(state: OrchestratorState, output: Extract<StageOutput, { stage: "write_script" }>): void {
  expectQueued(state, "write_script", output.subjectId);
  if (output.artifacts.script === undefined) invalid("write_script passed without its written script artifact", "write_script");
  mergeArtifacts(state, output.artifacts);
  state.nodes.write_script.status = "passed";
}

/** The reason a paid stage pauses the request when no reservation exists yet (Bible 5.1, 14). Names the stage. */

export function unfundedReason(stage: EngineStage): string {
  return (
    `${stage} is a paid stage and needs a budget reservation on the request, and none exists yet. Intake does not reserve, ` +
    "and estimate_reserve runs after the plan (Bible 5.1, 6.1, 14). No paid call is queued."
  );
}

export function applySingleGate(
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

export function failNode(state: OrchestratorState, node: SingleNode, gate: GateResult, redoLimit: number, effects: EngineEffect[]): void {
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

export function applyPlan(state: OrchestratorState, output: Extract<StageOutput, { stage: "plan" }>, effects: EngineEffect[]): void {
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

export function applyEstimate(state: OrchestratorState, output: Extract<StageOutput, { stage: "estimate_reserve" }>): void {
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

export function applyDeliver(state: OrchestratorState, output: Extract<StageOutput, { stage: "deliver" }>, effects: EngineEffect[]): void {
  expectQueued(state, "deliver", output.subjectId);
  mergeArtifacts(state, output.artifacts);
  state.nodes.deliver.status = "passed";
  state.status = "delivered";
  state.manifestId = output.manifestId;
  effects.push({ kind: "delivered", manifestId: output.manifestId });
}
