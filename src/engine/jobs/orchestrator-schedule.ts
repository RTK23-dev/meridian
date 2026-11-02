// Scheduling: after an event, every node whose inputs are ready and not yet queued is queued. Moved out of
// engine/jobs/orchestrator.ts unchanged (coding loop, T7).

import { EngineError } from "../contracts/index.ts";
import { STAGE_SPECS, engineJobKey, priorityNumber, type EngineStage } from "./registry.ts";
import type { EnginePayload, QueuedJob } from "./types.ts";
import { nextPhaseOf } from "../variants/work.ts";
import { markIssued, shotsToIssue, takesToCheck } from "./variant-runs.ts";
import { SINGLE_NODES, providerKeyFor, needsProduce, pauseWith, variantRunsOf, runOfBranch, nextAttempt, masterPassed, allShotsAccepted, variantsSettled, branchSlots } from "./orchestrator-state.ts";
import type { SingleNode, OrchestratorState } from "./orchestrator-state.ts";
import { unfundedReason } from "./orchestrator-single.ts";
import { variantChainIds, preRenderIdsOf } from "./orchestrator-variants.ts";

export function schedule(state: OrchestratorState): QueuedJob[] {
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
    // A brief is written after its reference is analysed (contract v8); a script request's write_script is passed from the start.
    write_script: n.intake.status === "passed" && n.analyze_reference.status === "passed",
    voice: n.intake.status === "passed" && n.write_script.status === "passed",
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
    // The scriptwriter reads the brief (the request) and the analysed reference (the dna slot).
    write_script: ["request", "dna"],
    // Voice reads the request's script, or the written script of a brief ("script" slot, contract v8).
    voice: ["request", "script"],
    plan: ["validated", "dna", "voice", "script"],
    // The request artifact carries the request's budget (constraints.budgetUsd), which the reservation needs (Bible 14.1).
    estimate_reserve: ["plan", "request", "model_choices"],
    // The validated request names the style kit and carries the emphasis marks the editor reads (E3, edit/STATUS.md item 1).
    edit: ["plan", "dna", "voice", "validated", "script", ...Object.values(state.shots).flatMap((shot) => (shot.acceptedTakeId ? [`take:${shot.acceptedTakeId}`] : []))],
    // The variants stage expands the request's matrix against its plan and its master (Bible 6.13).
    variants: state.masterEdlId === null ? [] : [`edl:${state.masterEdlId}`, "request", "plan", "script"],
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
            directives: shot.directives ?? [],
            modelChoice: shot.reviewerChoice ?? null,
          },
          // The request's model choices (Bible 10.5, contract v8), when the plan stage wrote them. A request without them has no slot,
          // and its produce jobs keep the route table.
          ["plan", "model_choices"],
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
        ["validated", "dna", "voice", "plan", "script"],
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
          ["request", "plan", "script"],
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
    // The assembly: the variant's EDL is built over its own plan, voice and takes (variants/assemble.ts). It waits for the picks.
    if (run.status === "assembling" && run.phase === null && run.picked !== null && state.masterEdlId !== null) {
      run.phase = "assemble";
      const own = variantChainIds(state, run);
      add(
        "variants",
        run.subject,
        { phase: "assemble", variantKey: run.key, masterEdlId: state.masterEdlId, work: run.work, text: null, voiceTrackId: run.voiceTrackId },
        [],
        [],
        [own.plan, state.artifacts.dna, state.artifacts.validated, state.artifacts.script, own.voice, ...own.takes],
      );
    }
  }

  for (const branch of Object.values(state.branches).sort((a, b) => a.edlId.localeCompare(b.edlId))) {
    if (branch.status !== "running" || branch.queued || branch.stage === "done") continue;
    branch.queued = true;
    const hints = branch.hints;
    branch.hints = [];
    const run = runOfBranch(state, branch);
    const explicit = run !== null && branch.stage === "pre_render_gate" ? preRenderIdsOf(state, run, branch.edlId) : undefined;
    add(branch.stage, branch.edlId, { edlId: branch.edlId, variantOf: branch.variantOf }, branchSlots(state, branch), hints, explicit);
  }

  return jobs;
}

function nodeDetails(state: OrchestratorState, node: SingleNode): Record<string, unknown> {
  if (node === "variants") return { masterEdlId: state.masterEdlId, variantCount: state.variantCount };
  // Delivery names the current master, so a revision delivers its own edit, not the superseded one (Bible 5.5, 6.14).
  if (node === "deliver") return { masterEdlId: state.masterEdlId, revision: state.revision ?? 0 };
  return {};
}
