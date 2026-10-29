// The remake events of the orchestrator: a shot remade while it is still making, and a remake of a delivered request. Moved out
// of engine/jobs/orchestrator.ts unchanged (coding loop, T7). orchestrator.ts dispatches to them.

import { remakeDirectiveOf, REMAKE_DIRECTIVES_MAX } from "./remake.ts";
import type { EngineEvent } from "./types.ts";
import { invalid, conflict, needsProduce } from "./orchestrator-state.ts";
import type { OrchestratorState, EngineEffect } from "./orchestrator-state.ts";

/**
 * Why a shot cannot be remade now, or null when it can (Bible 5.5). The one answer for the state machine, the caller that reserves the
 * remake, and the screen that shows the reason.
 */
export function remakeRefusalOf(state: OrchestratorState, shotId: string): string | null {
  if (state.status === "running") return midRunRefusalOf(state, shotId);
  if (state.status !== "delivered") {
    return state.status === "rejected"
      ? "A shot cannot be remade: this request was rejected."
      : "A shot is remade after its video is delivered. This video is still being made.";
  }
  const shot = state.shots[shotId];
  if (!shot) return "That shot is not in this video.";
  if (shot.status !== "accepted") return "That shot has no accepted take to replace.";
  if (!needsProduce(shot.sourceKind)) {
    return "A component or asset shot is not made by a take, so it cannot be remade. Changing it needs a new plan.";
  }
  return null;
}

/**
 * A shot still being made can be changed while its video is being made (D10): its direction or its model, not its source. Its in-flight take
 * becomes stale, and the shot is made again on the video's own reservation. A shot that is already accepted is changed after delivery.
 */
function midRunRefusalOf(state: OrchestratorState, shotId: string): string | null {
  const shot = state.shots[shotId];
  if (!shot) return "That shot is not in this video.";
  if (shot.status !== "pending") return "Only a shot that is still being made can be changed while the video is being made. An accepted shot is remade after delivery.";
  if (!needsProduce(shot.sourceKind)) return "A component or asset shot is not made by a take, so it cannot be remade.";
  return null;
}

/**
 * A person changed a shot that is still being made (D10). The shot starts a new epoch, so its in-flight take stops counting when it returns,
 * and it is made again with the direction and the model the person chose. No revision moves: the video is not delivered yet, and the
 * remake draws on the video\'s own reservation, which pays for the new call when it is made.
 */
function applyRemakeWhileMaking(state: OrchestratorState, event: Extract<EngineEvent, { type: "remake" }>, effects: EngineEffect[]): void {
  const refusal = midRunRefusalOf(state, event.shotId);
  if (refusal !== null) conflict(refusal, "produce_shot");
  const shot = state.shots[event.shotId];
  if (!shot) conflict(`shot ${event.shotId} is not in this video`, "produce_shot");
  if (event.budgetReservationId !== state.budgetReservationId) {
    conflict("a change while the video is made draws on the video's own reservation, so the reservation must be that one", "produce_shot");
  }
  const directive = remakeDirectiveOf(event.directive);
  const directives = shot.directives ?? [];
  if (directive !== null && directives.length >= REMAKE_DIRECTIVES_MAX) {
    conflict(`${shot.shotId} already has ${REMAKE_DIRECTIVES_MAX} directions, and no more are kept for it`, "produce_shot");
  }
  shot.epoch += 1;
  shot.round = 0;
  shot.issued = 0;
  shot.hints = [];
  shot.remade = true;
  shot.remakes = (shot.remakes ?? 0) + 1;
  shot.directives = directive === null ? [...directives] : [...directives, directive];
  shot.reviewerChoice = event.modelChoice ?? null;
  effects.push({
    kind: "decision",
    decision: {
      at: event.at,
      chose: `change ${shot.shotId} while the video is made (epoch ${shot.epoch})`,
      alternatives: [],
      reason: directive ?? "A reviewer changed this shot while it was being made.",
      by: "human",
    },
  });
}

/**
 * A person asked for one accepted shot of a delivered video to be made again (Bible 5.5). The request runs again from the edit: the
 * shot gets a new take, the edit is cut again, and the chain to delivery runs on the new master. Plan, voice, script and every other
 * accepted take are kept. The shot starts a new epoch, so its old takes stop counting and its redo budget starts again. The old
 * master is superseded and stays on record. The remake's own reservation pays for it.
 */
export function applyRemake(state: OrchestratorState, event: Extract<EngineEvent, { type: "remake" }>, effects: EngineEffect[]): void {
  if (state.status === "running") {
    applyRemakeWhileMaking(state, event, effects);
    return;
  }
  const refusal = remakeRefusalOf(state, event.shotId);
  if (refusal !== null) conflict(refusal, "produce_shot");
  const shot = state.shots[event.shotId];
  if (!shot) conflict(`shot ${event.shotId} is not in this video`, "produce_shot");
  if (event.budgetReservationId.length === 0) invalid("a remake needs its own budget reservation", "produce_shot");
  const directive = remakeDirectiveOf(event.directive);
  const directives = shot.directives ?? [];
  if (directive !== null && directives.length >= REMAKE_DIRECTIVES_MAX) {
    conflict(`${shot.shotId} already has ${REMAKE_DIRECTIVES_MAX} directions, and no more are kept for it`, "produce_shot");
  }

  state.revision = (state.revision ?? 0) + 1;
  state.status = "running";
  state.manifestId = null;
  state.budgetReservationId = event.budgetReservationId;
  const master = state.masterEdlId === null ? undefined : state.branches[state.masterEdlId];
  if (master !== undefined && master.status === "passed") master.status = "superseded";
  // The variants of the superseded master are stale (Bible 6.13). They are kept on record, and the variant stage is run again on the new master.
  // A video is delivered only once its variants have settled, so no variant job is still in flight when a remake starts, and their keys can be
  // named again by the rebuild.
  for (const branch of Object.values(state.branches)) {
    if (branch.variantOf !== null && branch.status !== "superseded") branch.status = "superseded";
  }
  if (state.variantCount > 0) {
    state.variantRuns = {};
    state.nodes.variants = { status: "idle", redos: 0, hints: [] };
  }

  shot.epoch += 1;
  shot.round = 0;
  shot.issued = 0;
  shot.status = "pending";
  shot.acceptedTakeId = null;
  shot.hints = [];
  shot.replanQueued = false;
  shot.replanFailed = false;
  shot.remade = true;
  shot.remakes = (shot.remakes ?? 0) + 1;
  shot.directives = directive === null ? [...directives] : [...directives, directive];
  // A replacement (D7) changes what the shot is: its visual type, its source and what the produce job reads from its summary. Only a shot
  // that a take makes can be a replacement, so the produce path stays the one that runs.
  if (event.replacement) {
    const next = event.replacement;
    if (next.shotId !== shot.shotId) conflict(`the replacement is for ${next.shotId}, not ${shot.shotId}`, "produce_shot");
    const suppliedClip = next.sourceKind === "asset" && event.reviewerTake !== undefined && event.reviewerTake !== null;
    if (!needsProduce(next.sourceKind) && !suppliedClip) {
      conflict("a replacement must be a shot that a take makes (generate, stock or chain), or the reviewer's own clip", "produce_shot");
    }
    shot.visualType = next.visualType;
    shot.downgradeTo = next.downgradeTo;
    shot.sourceKind = next.sourceKind;
    shot.modelClass = next.modelClass;
    shot.takesWanted = next.takesWanted;
  }
  if (event.planArtifactId) state.artifacts.plan = event.planArtifactId;
  if (event.reviewerTake && event.replacement?.sourceKind === "asset") {
    // The reviewer's clip is the shot's take: it is accepted now, and no produce job is queued for the shot (D12).
    const clip = event.reviewerTake;
    state.takes[clip.takeId] = {
      takeId: clip.takeId,
      shotId: shot.shotId,
      round: 0,
      epoch: shot.epoch,
      stale: false,
      checkQueued: false,
      verdict: { verdict: clip.verdict, pass: true, confidence: 1, failing: [], criticEscalates: false, verdictArtifactId: clip.verdictArtifactId },
    };
    state.artifacts[`take:${clip.takeId}`] = clip.artifactId;
    state.artifacts[`verdict:${clip.takeId}`] = clip.verdictArtifactId;
    shot.acceptedTakeId = clip.takeId;
    shot.status = "accepted";
  }
  // A remake without a model names none, so the orchestrator's choice applies to it again (D11).
  shot.reviewerChoice = event.modelChoice ?? null;

  state.nodes.edit = { status: "idle", redos: 0, hints: [] };
  state.nodes.deliver = { status: "idle", redos: 0, hints: [] };
  effects.push({
    kind: "decision",
    decision: {
      at: event.at,
      chose: `remake ${shot.shotId} as revision ${state.revision}`,
      alternatives: [],
      reason: directive ?? (event.replacement ? `A reviewer changed this shot to ${event.replacement.visualType}.` : "A reviewer asked for another take of this shot."),
      by: "human",
    },
  });
}
