// The variant results of the orchestrator: the variant runs, their produce and check, and the assembly. Moved out of
// engine/jobs/orchestrator.ts unchanged (coding loop, T7). orchestrator.ts dispatches to them.

import type { EngineEvent, StageOutput } from "./types.ts";
import { applyAssemblyOutcome, applyPlanOutcome, applyProduceResult, applyVerdict, applyVoiceOutcome, applyWriterOutcome, failVariantRun, isTerminal, newVariantRun, type VariantRun } from "./variant-runs.ts";
import { orchestratorLimits, invalid, conflict, mergeArtifacts, expectQueued, newBranch, variantRunsOf, endedRun, holdTextOf, picksOf } from "./orchestrator-state.ts";
import type { OrchestratorState, EngineEffect } from "./orchestrator-state.ts";

/**
 * The request phase of the variants stage (Bible 6.13). Its EDLs (caption and music) become branches. Its work list starts one run for
 * each generation variant, and the runs are queued by schedule(). A variant's plan and voice are its own: they stay in its run, not in
 * the request's artifacts, since deliver reads every request artifact and needs exactly one scene plan (handlers/deliver.ts).
 */
export function applyVariants(state: OrchestratorState, output: Extract<StageOutput, { stage: "variants"; phase: "request" }>): void {
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

export function applyVariantPhase(state: OrchestratorState, output: Extract<StageOutput, { stage: "variants"; phase: "writer" | "voice" | "plan" }>, effects: EngineEffect[]): void {
  const run = variantRunsOf(state)[output.key];
  if (!run || run.subject !== output.subjectId) invalid(`variant ${output.key} is not in the variant work list`, "variants");
  if (run.phase !== output.phase) conflict(`variant ${output.key} is not waiting for its ${output.phase} phase`, "variants");
  const before = isTerminal(run);
  if (output.phase === "writer") applyWriterOutcome(run, output.outcome);
  else if (output.phase === "voice") applyVoiceOutcome(run, output.outcome);
  else applyPlanOutcome(run, output.outcome);
  endedRun(before, run, effects);
}

export function applyVariantProduce(run: VariantRun, output: Extract<StageOutput, { stage: "produce_shot" }>, effects: EngineEffect[]): void {
  const before = isTerminal(run);
  for (const decision of output.decisions ?? []) effects.push({ kind: "decision", decision });
  const takeSlot = output.takeId === null ? null : `take:${output.takeId}`;
  const takeArtifactId = takeSlot === null ? null : (output.artifacts[takeSlot] ?? null);
  applyProduceResult(run, { shotId: output.shotId, takeId: output.takeId, takeArtifactId, held: holdTextOf(output) });
  if (takeSlot !== null && takeArtifactId !== null) run.artifacts[takeSlot] = takeArtifactId;
  endedRun(before, run, effects);
}

export function applyVariantCheck(run: VariantRun, output: Extract<StageOutput, { stage: "check_take" }>, effects: EngineEffect[]): void {
  const before = isTerminal(run);
  if (output.gate.pass !== output.verdict.pass) invalid("the take gate and the verdict disagree", "check_take");
  applyVerdict(run, { takeId: output.takeId, verdict: output.verdict, redosPerShot: orchestratorLimits.shotRedos });
  const verdictArtifact = output.artifacts[`verdict:${output.takeId}`];
  if (verdictArtifact) run.artifacts[`verdict:${output.takeId}`] = verdictArtifact;
  endedRun(before, run, effects);
}

/** A dead job of a variant ends that variant alone. A job of a run that has ended changes nothing. */

export function applyVariantDead(run: VariantRun, event: Extract<EngineEvent, { type: "dead" }>, effects: EngineEffect[]): void {
  const before = isTerminal(run);
  failVariantRun(run, `${event.stage} for ${event.subjectId} died: ${event.reason}`);
  endedRun(before, run, effects);
}

/** The run a dead job belongs to, or null for a master job. A variant's phase, produce and check jobs are its own. */

export function settleVariantAssembly(state: OrchestratorState, effects: EngineEffect[]): void {
  for (const run of Object.values(variantRunsOf(state))) {
    if (run.status !== "assembling" || run.phase !== null || run.picked !== null) continue;
    const before = isTerminal(run);
    const picked = picksOf(state, run);
    if (picked === null) failVariantRun(run, "a shot the variant keeps has no accepted take to play");
    else run.picked = picked;
    endedRun(before, run, effects);
  }
}

/** The artifacts a variant's chain reads that are its own: its plan and its voice, and the takes its EDL plays. */

export function variantChainIds(state: OrchestratorState, run: VariantRun): { plan: string | undefined; voice: string | undefined; takes: string[] } {
  return {
    plan: run.artifacts[`plan:${run.key}`],
    voice: run.voiceTrackId === null ? state.artifacts.voice : run.artifacts[`voice:${run.key}`],
    takes: Object.values(run.picked ?? {}),
  };
}

/**
 * The inputs of a variant's pre-render gate, which are its own (Bible 6.10): its composition and EDL, its plan and voice (not the master's),
 * the validated request and the DNA, and the takes its EDL plays.
 */
export function preRenderIdsOf(state: OrchestratorState, run: VariantRun, edlId: string): (string | undefined)[] {
  const own = variantChainIds(state, run);
  return [
    state.artifacts[`composition:${edlId}`],
    state.artifacts[`edl:${edlId}`],
    own.plan,
    state.artifacts.validated,
    state.artifacts.script,
    own.voice,
    state.artifacts.dna,
    ...own.takes,
  ];
}

/**
 * The assembly of a generation variant (Bible 6.13): its EDL is built over its own inputs, and it becomes a branch of its own. The branch's
 * chain (compose, pre-render, render, review) runs as the master's does, with the variant's own plan, voice and takes.
 */
export function applyVariantAssembly(
  state: OrchestratorState,
  output: Extract<StageOutput, { stage: "variants"; phase: "assemble" }>,
  effects: EngineEffect[],
): void {
  const run = variantRunsOf(state)[output.key];
  if (!run || run.subject !== output.subjectId) invalid(`variant ${output.key} is not in the variant work list`, "variants");
  if (run.phase !== "assemble") conflict(`variant ${output.key} is not waiting for its assembly`, "variants");
  const before = isTerminal(run);
  effects.push({ kind: "gate", gate: output.gate });
  mergeArtifacts(state, output.artifacts);
  if (output.outcome.status === "done") {
    if (state.branches[output.edlId]) invalid(`variant EDL ${output.edlId} already has a branch`, "variants");
    for (const [takeId, artifactId] of Object.entries(run.picked ?? {})) state.artifacts[`take:${takeId}`] = artifactId;
    state.branches[output.edlId] = { ...newBranch(output.edlId, state.masterEdlId), variantKey: run.key };
    applyAssemblyOutcome(run, { status: "done", edlId: output.edlId });
  } else {
    applyAssemblyOutcome(run, { status: "not_built", reason: output.outcome.reason });
  }
  endedRun(before, run, effects);
}
