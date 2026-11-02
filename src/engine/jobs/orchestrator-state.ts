// The orchestrator's state and its shared helpers: the state shapes, the limits, and the small checks and lookups that
// more than one event family uses. Moved out of engine/jobs/orchestrator.ts unchanged (coding loop, T7).

import { EngineError, type Decision, type GateId, type GateResult, type ModelChoice, type ModelClass, type TakeVerdict } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { decideGate, type GateVerdict, type GoldMetrics } from "../review/gold.ts";
import type { EngineStage } from "./registry.ts";
import { jobSettings, type RequestPriority } from "./settings.ts";
import type { QueuedJob, ShotSourceKind, ShotSummary, StageOutput } from "./types.ts";
import { isTerminal, variantDecision, type VariantRun } from "./variant-runs.ts";

export const ORCHESTRATOR_STATE_SCHEMA = "engine.orchestrator_state/v1" as const;

/** The stages of a branch's chain (Bible 6.9 to 6.12). */

export const CHAIN_STAGES = ["compose", "pre_render_gate", "render", "post_render_review"] as const;

/** The stages that run once per request. Shots, takes and branches are tracked in their own maps. */

export const SINGLE_NODES = ["intake", "analyze_reference", "write_script", "voice", "plan", "estimate_reserve", "edit", "variants", "deliver"] as const;

export type SingleNode = (typeof SINGLE_NODES)[number];

/** Branch stages: the chain from an EDL to a delivered video (stages 9 to 12). "done" means the branch passed review. */

export type BranchStage = "compose" | "pre_render_gate" | "render" | "post_render_review" | "done";

export type NodeState = { status: "idle" | "queued" | "passed"; redos: number; hints: string[] };

export type ShotState = ShotSummary & {
  /** The reviewer's model for this shot's remake (D11). Null or absent: the orchestrator's choice applies. */
  reviewerChoice?: ModelChoice | null;
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
  /**
   * A person remade this shot (Bible 5.5). Its later failures go to a person: the shot escalates instead of downgrading, because a
   * downgrade replans the whole plan. Absent in states written before remakes, which reads as false.
   */
  remade?: boolean;
  /** How many times a person has remade this shot. Absent reads as 0. */
  remakes?: number;
  /** The reviewer's directions for this shot, oldest first. Each produce job of the shot carries them (remake.ts). */
  directives?: string[];
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
  /**
   * The generation variant this branch is the chain of (its run's key), or null. A caption, music or master branch has none. A
   * generation variant's branch fails alone (escalateBranch), and it never revises the master's shots or edit.
   */
  variantKey?: string | null;
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
  /**
   * How many times a person has remade a shot of this delivered video (Bible 5.5). Each remake makes a new revision, which delivers a
   * new master. Absent before the first remake, which reads as 0.
   */
  revision?: number;
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

export const MAX_HINTS = 8;

export function invalid(message: string, stage?: string): never {
  throw new EngineError("invalid_input", message, { stage });
}

export function conflict(message: string, stage?: string): never {
  throw new EngineError("conflict", message, { stage });
}

/**
 * The provider concurrency bucket of a produce job (Bible 10.4). Stock has its own bucket. A chain's bucket is its first call's
 * (the plan summary gives that class); each of its calls is still limited by its own adapter's bucket in the router.
 */
export function providerKeyFor(sourceKind: ShotSourceKind, modelClass: ModelClass | null): string {
  if (sourceKind === "stock") return "stock";
  if (modelClass === "tts") return "tts";
  if (modelClass !== null && modelClass.startsWith("image.")) return "image";
  return "video";
}

/**
 * Generation, stock and a chain of calls (contract v5) need a produce job. Components are rendered in the composition; assets already
 * exist.
 */
export function needsProduce(sourceKind: ShotSourceKind): boolean {
  return sourceKind === "generate" || sourceKind === "stock" || sourceKind === "chain";
}

export function failingRules(gate: GateResult): string[] {
  return [...new Set(gate.checks.filter((check) => !check.pass).map((check) => check.rule))].sort().slice(0, MAX_HINTS);
}

export function verdictRules(verdict: TakeVerdict): string[] {
  return [...new Set(verdict.checks.filter((check) => !check.pass).map((check) => check.rule))].sort().slice(0, MAX_HINTS);
}

export function reasonsOf(gate: GateResult): string[] {
  const reasons = gate.checks.filter((check) => !check.pass).map((check) => (check.detail ? `${check.rule}: ${check.detail}` : check.rule));
  return reasons.length > 0 ? reasons : [`${gate.gate} gate failed`];
}

export function checkGate(stage: EngineStage, gate: GateResult): void {
  const expected = GATE_FOR_STAGE[stage];
  if (expected !== undefined && gate.gate !== expected) {
    invalid(`${stage} must report the ${expected} gate, not ${gate.gate}`, stage);
  }
}

export function mergeArtifacts(state: OrchestratorState, artifacts: Record<string, string>): void {
  for (const [slot, id] of Object.entries(artifacts)) state.artifacts[slot] = id;
}

export function expectQueued(state: OrchestratorState, node: SingleNode, subjectId: string): void {
  if (state.nodes[node].status !== "queued") conflict(`${node} is not waiting for a result`, node);
  if (subjectId !== state.requestId) invalid(`${node} reports for ${subjectId}, not for the request`, node);
}

export function pauseWith(state: OrchestratorState, pause: Pause): void {
  if (state.pause === null) state.pause = pause;
  state.status = "paused";
}

export function escalateRequest(state: OrchestratorState, pause: Pause, detail: Record<string, unknown>, effects: EngineEffect[]): void {
  pauseWith(state, pause);
  effects.push({ kind: "review_item", reviewKind: "escalation", reason: pause.reason, subjectId: pause.subjectId, detail });
}

export function isCurrent(state: OrchestratorState, take: TakeState): boolean {
  const shot = state.shots[take.shotId];
  return shot !== undefined && !take.stale && take.epoch === shot.epoch && shot.status === "pending";
}

/** Once every take of the current round has a verdict, act on the round (Bible 5.3). */

export function takesOf(state: OrchestratorState, shotId: string, round: number, epoch: number): TakeState[] {
  return Object.values(state.takes)
    .filter((take) => take.shotId === shotId && take.round === round && take.epoch === epoch && !take.stale)
    .sort((a, b) => a.takeId.localeCompare(b.takeId));
}

export function newBranch(edlId: string, variantOf: string | null): BranchState {
  return { edlId, variantOf, stage: "compose", queued: false, status: "running", redos: {}, hints: [] };
}

/** The branch must be waiting on exactly this stage. Anything else is a stale or duplicate result. */

export function expectBranch(state: OrchestratorState, edlId: string, stage: BranchStage, stageName: EngineStage): BranchState {
  const branch = state.branches[edlId];
  if (!branch || !branch.queued || branch.stage !== stage || branch.status !== "running") {
    conflict(`${stageName} for ${edlId} is not waiting for a result`, stageName);
  }
  return branch;
}

function metricsOf(state: OrchestratorState): Record<string, GoldMetrics | undefined> {
  return state.gateMetrics ?? {};
}

/** How a failed gate routes (Bible 5.3, 12.4): block when a failing check is proven, review when none is. Pure. */

export function verdictOf(state: OrchestratorState, gate: GateResult): GateVerdict {
  return decideGate(gate, metricsOf(state)).verdict;
}

/** The first artifact of a slot family ("integrity:", "review:"), or null. Stage outputs name their artifacts by slot. */

export function artifactWithPrefix(artifacts: Record<string, string>, prefix: string): string | null {
  return Object.entries(artifacts).find(([slot]) => slot.startsWith(prefix))?.[1] ?? null;
}

// --- Variant runs (Bible 6.13) -------------------------------------------------------------------------------------------------------
// A run's phases, produce jobs and checks are queued by schedule() and applied here. A run never pauses the request. Its end is a
// decision in the manifest (variantDecision), so a produced or failed variant is on record with its reason.

export function variantRunsOf(state: OrchestratorState): Record<string, VariantRun> {
  return state.variantRuns ?? {};
}

/** The run that owns a produce job's subject: one of its shots' subjects. Null for a master produce job. */

export function runOfProduce(state: OrchestratorState, subjectId: string): VariantRun | null {
  return Object.values(variantRunsOf(state)).find((run) => Object.values(run.shots).some((shot) => shot.subject === subjectId)) ?? null;
}

/** The run that owns a take: the run that made it. Null for a master take. */

export function runOfTake(state: OrchestratorState, takeId: string): VariantRun | null {
  return Object.values(variantRunsOf(state)).find((run) => run.takes[takeId] !== undefined) ?? null;
}

/** Records a decision once, when a run ends (produced or failed). */

export function runOfBranch(state: OrchestratorState, branch: BranchState): VariantRun | null {
  if (branch.variantKey === undefined || branch.variantKey === null) return null;
  return variantRunsOf(state)[branch.variantKey] ?? null;
}

export function variantRunOfDead(state: OrchestratorState, stage: EngineStage, subjectId: string): VariantRun | null {
  if (stage === "variants") return Object.values(variantRunsOf(state)).find((run) => run.subject === subjectId) ?? null;
  if (stage === "produce_shot") return runOfProduce(state, subjectId);
  if (stage === "check_take") return runOfTake(state, subjectId);
  return null;
}

/** The run a branch is the chain of, or null for a caption, music or master branch. */

export function isSingleNode(stage: string): stage is SingleNode {
  return (SINGLE_NODES as readonly string[]).includes(stage);
}

// --- Scheduling -------------------------------------------------------------------------------------------------------

export function nextAttempt(state: OrchestratorState, stage: EngineStage, subjectId: string): string {
  const slot = `${stage}|${subjectId}`;
  const attempt = (state.sequences[slot] ?? 0) + 1;
  state.sequences[slot] = attempt;
  return String(attempt);
}

export function masterPassed(state: OrchestratorState): boolean {
  return state.masterEdlId !== null && state.branches[state.masterEdlId]?.status === "passed";
}

/** Delivery waits for every variant EDL's chain and every generation variant's run to end (a produced or a failed run). */

export function allShotsAccepted(state: OrchestratorState): boolean {
  const shots = Object.values(state.shots);
  return shots.length > 0 && shots.every((shot) => shot.status === "accepted");
}

export function variantsSettled(state: OrchestratorState): boolean {
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
export function branchSlots(state: OrchestratorState, branch: BranchState): string[] {
  const edl = `edl:${branch.edlId}`;
  switch (branch.stage) {
    case "compose":
      return [edl, "validated"];
    case "pre_render_gate":
      return [`composition:${branch.edlId}`, edl, "plan", "validated", "script", "voice", "dna", ...acceptedTakeSlots(state)];
    case "render":
      return [`composition:${branch.edlId}`, edl, "validated"];
    case "post_render_review":
      return [`render:${branch.edlId}`, `integrity:${branch.edlId}`, edl];
    case "done":
      return [];
  }
}

/** Queue every job that is ready and not yet queued. Mutates the state it is given (the caller passes a copy). */

export function endedRun(before: boolean, run: VariantRun, effects: EngineEffect[]): void {
  if (!before && isTerminal(run)) effects.push({ kind: "decision", decision: variantDecision(run) });
}

export function holdTextOf(output: Extract<StageOutput, { stage: "produce_shot" }>): string | null {
  if (output.hold === undefined) return null;
  if (output.hold.kind === "budget") return `the budget held shot ${output.shotId}: ${output.hold.reason}`;
  return `the provider refused shot ${output.shotId} (${output.hold.errorKind})`;
}

/**
 * The take each generated or stock shot of the master plan plays in a variant's EDL: the variant's own accepted take for a shot it changed,
 * else the master's accepted take. Null when a shot the EDL plays has no take (the variant cannot be assembled, Bible 6.13).
 */
export function picksOf(state: OrchestratorState, run: VariantRun): Record<string, string> | null {
  const picked: Record<string, string> = {};
  for (const shot of Object.values(state.shots)) {
    if (!needsProduce(shot.sourceKind)) continue;
    const own = run.shots[shot.shotId];
    const takeId = own !== undefined ? own.takeId : shot.acceptedTakeId;
    if (takeId === null) return null;
    const artifactId = own !== undefined ? run.artifacts[`take:${takeId}`] : state.artifacts[`take:${takeId}`];
    if (artifactId === undefined) return null;
    picked[takeId] = artifactId;
  }
  return picked;
}

/** A run that is assembling records which take each shot plays. A shot with no take to play fails the run, so nothing waits on it. */

export function branchStageName(stage: BranchStage): EngineStage {
  return stage === "done" ? "post_render_review" : stage;
}

export function failingShotIds(state: OrchestratorState, gate: GateResult): string[] {
  return [...new Set(gate.failingShotIds ?? [])].filter((id) => state.shots[id] !== undefined).sort();
}

/** A branch stage failed with no shot to blame: redo that stage up to the limit, then escalate. */

export function supersedeBranch(branch: BranchState): void {
  branch.status = "superseded";
  branch.queued = false;
}
