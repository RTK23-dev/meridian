// The variant runs of the orchestrator (Video Engine Bible 6.13, 5.3). One run per generation variant. Its phases (writer, voice, plan) come
// first; then one produce job for each shot the change makes again, and one check for each take; then the assembly (the variant's EDL, built
// by the editor over the variant's own plan, voice and takes: variants/assemble.ts); then the variant's chain (compose, pre-render, render and
// review, as the master's). The run is pure state: the orchestrator (orchestrator.ts) reads it to queue jobs and applies each result to it.
//
// A variant fails alone (Bible 6.13). A phase that cannot finish, a produce job that makes no take, a take that fails its checks after the
// shot's redos, an assembly that does not pass the edit gate, or a chain that does not pass review each end that variant with its reason.
// It never pauses the request and never re-plans or re-edits the master. Redos are the shot's redos (orchestratorLimits.shotRedos, Bible 5.3)
// and the chain's stage redos. A variant does not wait for a human choice.
//
// A produced run is one whose EDL passed review. Deliver chooses it with the master, as it chooses the master's own video (deliver/videos.ts).

import type { Decision, TakeVerdict } from "../contracts/index.ts";
import type { VariantWorkItem, VariantPhase } from "../variants/work.ts";
import { variantShotSubjectOf } from "../variants/work.ts";
import type { WriterText } from "../variants/writer.ts";
import type { VariantPlanOutcome, VariantVoiceOutcome, VariantWriterOutcome, ShotSummary } from "./types.ts";

/**
 * The lifecycle of a run: preparing (its phases), producing (its shots), assembling (the EDL is queued or being built), rendering (its
 * chain: compose, pre-render, render and review), then produced (the chain passed) or failed (with a reason).
 */
export type VariantRunStatus = "preparing" | "producing" | "assembling" | "rendering" | "produced" | "failed";

export type VariantShotRun = {
  shotId: string;
  /** The subject of its produce jobs (variantShotSubjectOf). It is never a master shot's id. */
  subject: string;
  visualType: ShotSummary["visualType"];
  downgradeTo: ShotSummary["downgradeTo"];
  modelClass: ShotSummary["modelClass"];
  takesWanted: 1 | 2;
  /** Redo round, from 0. A redo starts a new round (Bible 5.3). */
  round: number;
  /** Produce jobs issued in this round. */
  issued: number;
  /** Takes of this round that have a verdict. */
  checked: number;
  accepted: boolean;
  /** The take that was accepted for this shot, once it passed its check. The EDL plays it. */
  takeId: string | null;
  /** Rule names of the failed checks, for the next round's produce jobs. Never free text (Bible 1). */
  hints: string[];
};

export type VariantTakeRun = {
  takeId: string;
  shotId: string;
  round: number;
  /** The take's artifact (its slot is take:<takeId>), so the check job can read it. */
  artifactId: string | null;
  checkQueued: boolean;
  verdict: { pass: boolean; failing: string[]; action: TakeVerdict["action"] } | null;
};

export type VariantRun = {
  key: string;
  subject: string;
  work: VariantWorkItem;
  status: VariantRunStatus;
  /** The phase whose job is in flight, or null. */
  phase: VariantPhase | null;
  /** The phases finished, in order. */
  done: VariantPhase[];
  /** What the writer wrote, for the voice and the plan. Null until the writer's phase is done (or when no words change). */
  text: WriterText | null;
  voiceTrackId: string | null;
  /** The variant's own artifacts: plan:<key>, voice:<key>, take:<id> and verdict:<id>. They are not request artifacts (deliver reads the request's). */
  artifacts: Record<string, string>;
  shots: Record<string, VariantShotRun>;
  takes: Record<string, VariantTakeRun>;
  /** The EDL the assembly built, once it passed. Its chain runs under this id. */
  edlId: string | null;
  /**
   * The take of every generated shot the EDL plays (the master's accepted take, or the variant's own), with its artifact id. Null until the
   * run is assembling and every shot has a take to play.
   */
  picked: Record<string, string> | null;
  /** Why the run failed, or what it is waiting for. Null while it runs well. */
  reason: string | null;
};

/** A run starts with its work list: nothing is done and no phase is in flight. */
export function newVariantRun(work: VariantWorkItem): VariantRun {
  return {
    key: work.key,
    subject: work.subject,
    work,
    status: "preparing",
    phase: null,
    done: [],
    text: null,
    voiceTrackId: null,
    artifacts: {},
    shots: {},
    takes: {},
    edlId: null,
    picked: null,
    reason: null,
  };
}

/** A run has ended: its variant is produced (its chain passed review) or failed. */
export function isTerminal(run: VariantRun): boolean {
  return run.status === "produced" || run.status === "failed";
}

/** The run's end when a phase or a job cannot finish it. The reason names the cause, and the run never pauses the request. */
export function failVariantRun(run: VariantRun, reason: string): void {
  if (isTerminal(run)) return;
  run.status = "failed";
  run.phase = null;
  run.reason = reason;
}

/** The decision a terminal run records (Bible 16, the manifest's decisions). Pure. */
export function variantDecision(run: VariantRun): Decision {
  const produced = run.status === "produced";
  return {
    at: `variant:${run.key}`,
    chose: produced ? "produced" : "failed",
    alternatives: [],
    reason: produced ? "its EDL passed the edit gate and its chain passed review" : `not built: ${run.reason ?? "no reason recorded"}`,
    by: "scorer",
  };
}

/** The writer's phase outcome. A done writer keeps its text; a not_built writer fails the run. */
export function applyWriterOutcome(run: VariantRun, outcome: VariantWriterOutcome): void {
  run.phase = null;
  if (outcome.status === "not_built") return failVariantRun(run, outcome.reason);
  run.text = outcome.text;
  run.done.push("writer");
}

/** The voice phase's outcome. A done voice keeps its track and its artifact; a not_built voice fails the run. */
export function applyVoiceOutcome(run: VariantRun, outcome: VariantVoiceOutcome): void {
  run.phase = null;
  if (outcome.status === "not_built") return failVariantRun(run, outcome.reason);
  run.voiceTrackId = outcome.voiceTrackId;
  Object.assign(run.artifacts, outcome.artifacts);
  run.done.push("voice");
}

/**
 * The plan phase's outcome. A done plan opens the produce stage: one shot per generated shot the change touches, each with its own
 * subject. A plan whose shots are not the work list's shots fails the run. With no shot to make again, the run is assembling at once.
 */
export function applyPlanOutcome(run: VariantRun, outcome: VariantPlanOutcome): void {
  run.phase = null;
  if (outcome.status === "not_built") return failVariantRun(run, outcome.reason);
  const wanted = [...run.work.produceShotIds].sort();
  const got = outcome.produce.map((shot) => shot.shotId).sort();
  if (wanted.length !== got.length || wanted.some((id, index) => id !== got[index])) {
    return failVariantRun(run, "the variant's plan does not name the shots its change makes again");
  }
  Object.assign(run.artifacts, outcome.artifacts);
  run.done.push("plan");
  for (const shot of [...outcome.produce].sort((a, b) => a.shotId.localeCompare(b.shotId))) {
    run.shots[shot.shotId] = {
      shotId: shot.shotId,
      subject: variantShotSubjectOf(run.subject, shot.shotId),
      visualType: shot.visualType,
      downgradeTo: shot.downgradeTo,
      modelClass: shot.modelClass,
      takesWanted: shot.takesWanted,
      round: 0,
      issued: 0,
      checked: 0,
      accepted: false,
      takeId: null,
      hints: [],
    };
  }
  run.status = wanted.length === 0 ? "assembling" : "producing";
}

/** The shots of a producing run that need a produce job now: not accepted, and fewer takes issued this round than wanted. */
export function shotsToIssue(run: VariantRun): VariantShotRun[] {
  if (run.status !== "producing") return [];
  return Object.values(run.shots)
    .filter((shot) => !shot.accepted && shot.issued < shot.takesWanted)
    .sort((a, b) => a.shotId.localeCompare(b.shotId));
}

/**
 * Counts a produce job as issued for its shot, and returns the hints it carries. The hints stay on the shot until it is accepted, so
 * every take of a redo round is told the rules its earlier round failed.
 */
export function markIssued(run: VariantRun, shotId: string): string[] {
  const shot = run.shots[shotId];
  if (!shot) throw new Error(`variant ${run.key} has no shot ${shotId}`);
  shot.issued += 1;
  return [...shot.hints];
}

/** A produce result for one of the run's shots. A hold fails the run; a take is recorded and waits for its check. */
export function applyProduceResult(
  run: VariantRun,
  input: { shotId: string; takeId: string | null; takeArtifactId: string | null; held: string | null },
): void {
  if (run.status !== "producing") return;
  if (input.takeId === null) {
    return failVariantRun(run, input.held ?? `shot ${input.shotId} made no take`);
  }
  const shot = run.shots[input.shotId];
  if (!shot) return failVariantRun(run, `shot ${input.shotId} is not one of the variant's shots`);
  run.takes[input.takeId] = {
    takeId: input.takeId,
    shotId: input.shotId,
    round: shot.round,
    artifactId: input.takeArtifactId,
    checkQueued: false,
    verdict: null,
  };
}

/**
 * The takes that need a check job now: a take with no verdict and no check in flight, of a shot not yet accepted. A second take of an
 * accepted shot is not checked: nothing it could decide is needed.
 */
export function takesToCheck(run: VariantRun): VariantTakeRun[] {
  if (run.status !== "producing") return [];
  return Object.values(run.takes)
    .filter((take) => take.verdict === null && !take.checkQueued && run.shots[take.shotId]?.accepted !== true)
    .sort((a, b) => a.takeId.localeCompare(b.takeId));
}

/**
 * A check's verdict for one take. A pass accepts its shot; when every shot is accepted the run is assembling. A fail is a redo of the shot
 * while it has redos left (its round starts again with the failed rules as hints), and a fail with none left fails the run. An escalation
 * fails the run: a variant does not wait for a human choice.
 */
export function applyVerdict(run: VariantRun, input: { takeId: string; verdict: TakeVerdict; redosPerShot: number }): void {
  const take = run.takes[input.takeId];
  if (!take) return failVariantRun(run, `take ${input.takeId} is not a take of the variant`);
  const failing = input.verdict.checks.filter((check) => !check.pass).map((check) => check.rule);
  take.checkQueued = false;
  take.verdict = { pass: input.verdict.pass, failing, action: input.verdict.action };
  const shot = run.shots[take.shotId];
  if (!shot || run.status !== "producing") return;
  if (shot.accepted) return;
  if (input.verdict.pass) {
    shot.accepted = true;
    shot.takeId = take.takeId;
    if (Object.values(run.shots).every((candidate) => candidate.accepted)) run.status = "assembling";
    return;
  }
  if (input.verdict.action === "escalate") {
    return failVariantRun(run, `the take gate escalated shot ${shot.shotId}; a variant does not wait for a human choice`);
  }
  if (take.round !== shot.round) return; // a take of an earlier round, kept on record only
  shot.checked += 1;
  shot.hints = [...new Set([...shot.hints, ...failing])].sort().slice(0, 8);
  if (shot.checked < shot.issued) return; // the other takes of this round are still to be checked
  if (shot.round < input.redosPerShot) {
    shot.round += 1;
    shot.issued = 0;
    shot.checked = 0;
    return;
  }
  return failVariantRun(run, `shot ${shot.shotId} did not pass its checks after ${input.redosPerShot} redos (${shot.hints.join(", ") || "no rule named"})`);
}

/** The assembly's outcome. A built EDL starts the variant's chain; an EDL that does not pass the edit gate fails the variant. */
export function applyAssemblyOutcome(run: VariantRun, outcome: { status: "done"; edlId: string } | { status: "not_built"; reason: string }): void {
  if (run.status !== "assembling" || run.phase !== "assemble") return;
  run.phase = null;
  if (outcome.status === "not_built") return failVariantRun(run, outcome.reason);
  run.edlId = outcome.edlId;
  run.status = "rendering";
}

/** The chain of the variant passed review (its post-render review passed): the variant is produced. */
export function passVariantRun(run: VariantRun): void {
  if (run.status !== "rendering") return;
  run.status = "produced";
}
