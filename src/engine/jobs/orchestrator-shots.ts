// The shot results of the orchestrator: produce, hold, the take check, the rounds and the escalations. Moved out of
// engine/jobs/orchestrator.ts unchanged (coding loop, T7). orchestrator.ts dispatches to them.

import { takeReviewItem } from "../review/inbox.ts";
import type { ProduceHold, ShotSummary, StageOutput } from "./types.ts";
import { orchestratorLimits, MAX_HINTS, invalid, conflict, needsProduce, verdictRules, mergeArtifacts, pauseWith, isCurrent, takesOf } from "./orchestrator-state.ts";
import type { ShotState, TakeVerdictState, OrchestratorState, EngineEffect } from "./orchestrator-state.ts";

export function shotFromSummary(summary: ShotSummary, previous: ShotState | null): ShotState {
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

export function applyProduce(state: OrchestratorState, output: Extract<StageOutput, { stage: "produce_shot" }>, effects: EngineEffect[]): void {
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

export function applyCheck(state: OrchestratorState, output: Extract<StageOutput, { stage: "check_take" }>, effects: EngineEffect[]): void {
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

export function downgradeOrEscalate(state: OrchestratorState, shot: ShotState, why: string, effects: EngineEffect[]): void {
  // A person chose this shot's remake. If it fails, the person decides, rather than a downgrade that replans the whole master (Bible 5.5).
  if (shot.remade === true) {
    escalateShot(state, shot, `${why}; a person remade ${shot.shotId}, so it goes to review instead of a downgrade`, effects);
    return;
  }
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

export function escalateShot(state: OrchestratorState, shot: ShotState, reason: string, effects: EngineEffect[]): void {
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
