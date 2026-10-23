// The plan stage's work (Bible 6.4, steps 1 to 7): align the beats, split them into shots, decide each shot's visual type (7.2 to
// 7.6), write the generation prompts and stock queries (planner, one Opus call), run the director check (7.7, one Opus call),
// build every shot's source, name the fallback of every generated shot, and run the plan gate (12.1).
//
// planScene returns a GateResult on every path. A plan that cannot be built is refused with the check that stopped it, and no
// plan is returned, so nothing downstream reads a half-built plan. A plan that is built but fails its gate is returned with the
// failing shots named (6.10), so the review can show it. Apart from the two role calls it is pure.

import { createHash } from "node:crypto";
import type { BudgetAlert } from "../budget/reserve.ts";
import { runRole, type RoleCall, type RoleDeps } from "../claude/client.ts";
import { planner, type PlannerAnswer, type PlannerShot } from "../claude/roles/planner.ts";
import type { DirectorCheckAnswer, DirectorShot } from "../claude/roles/director_check.ts";
import {
  EngineError,
  type CharacterSheet,
  type Decision,
  type GateCheck,
  type GateResult,
  type Persona,
  type ProductKit,
  type ProductionRequest,
  type ScenePlan,
  type ShotLayer,
  type ShotSource,
  type ShotSpec,
  type StyleKit,
  type ValidatedRequest,
  type VideoDNA,
  type VisualType,
  type VoiceTrack,
} from "../contracts/index.ts";
import { check, gateResult } from "../review/gates/common.ts";
import { checkPlan } from "../review/gates/plan.ts";
import type { VisualClassification } from "../review/gates/request.ts";
import { alignmentDecisions, alignShots, DEFAULT_SHOT_LENGTH, timedWordsOfShot, type AlignOutput, type ShotLengthLimits } from "./align.ts";
import { rigSheetOf } from "./character.ts";
import { planTotals, shotCost, type PlanLine } from "./cost.ts";
import { applyDirectorCheck, runDirectorCheck, type DirectorChoice } from "./director.ts";
import { kitRejection, mustAllowedTypes, productPixelRejection } from "./filter.ts";
import { planKitsOf } from "./minimum.ts";
import { directorTaskOf, needsPrompt, needsQuery, plannerTaskOf } from "./prompts.ts";
import { heroUriOf, productImageUris } from "./product.ts";
import { buildSource, componentBuildRefusals, emphasisIn, type WordSpan } from "./sources.ts";
import { DOWNGRADE_TO, isGeneratedType } from "./tables.ts";
import type { ScriptBody } from "../script/resolve.ts";
import type { PlanKits, ShotInput } from "./types.ts";
import { decideVisuals, type ShotChoice, type VisualDecisionResult } from "./visual.ts";

/** The kit bodies the plan loaded. A kit that did not load is absent (7.2 rule 6, 13). */
export type PlanKitBodies = {
  styleKit?: StyleKit;
  persona?: Persona;
  productKit?: ProductKit;
  characters: CharacterSheet[];
};

export type PlanSceneInput = {
  requestId: string;
  workspaceId: string;
  /** The request's budget reservation. Both role calls are made only against it (Bible 14.1). */
  reservationId: string;
  attempt?: number;
  signal?: AbortSignal;
  request: ProductionRequest;
  /** The words the plan covers: the request's script, or a brief's written script (script/resolve.ts). */
  script: ScriptBody;
  validated: ValidatedRequest;
  voice: VoiceTrack;
  dna: VideoDNA;
  kits: PlanKitBodies;
  /** The classification of every visual request (classify.ts). */
  classifications: readonly VisualClassification[];
  deps: RoleDeps;
};

export type PlanSceneOutcome = {
  /** Always present. It passes only when the plan is built and every check of the plan gate passes. */
  gate: GateResult;
  /** The built plan, or null when no plan could be built. A built plan may still fail its gate. */
  plan: ScenePlan | null;
  calls: RoleCall[];
  alerts: BudgetAlert[];
};

/** The kit bodies must be the versions intake validated. A kit that drifted, or did not load, fails this check. */
export function kitMatchCheck(validated: ValidatedRequest, kits: PlanKitBodies): GateCheck {
  const problems: string[] = [];
  const style = validated.kits.styleKit;
  if (kits.styleKit === undefined) {
    problems.push(`style kit ${style.id} did not load`);
  } else if (kits.styleKit.styleKitId !== style.id || kits.styleKit.version !== style.version) {
    problems.push(`style kit ${kits.styleKit.styleKitId} v${kits.styleKit.version} differs from the validated ${style.id} v${style.version}`);
  }
  if (validated.kits.persona !== undefined) {
    const ref = validated.kits.persona;
    if (kits.persona === undefined || kits.persona.personaId !== ref.id || kits.persona.version !== ref.version) {
      problems.push(`persona ${ref.id} v${ref.version} did not load as validated`);
    }
  }
  if (validated.kits.productKit !== undefined) {
    const ref = validated.kits.productKit;
    if (kits.productKit === undefined || kits.productKit.productKitId !== ref.id || kits.productKit.version !== ref.version) {
      problems.push(`product kit ${ref.id} v${ref.version} did not load as validated`);
    }
  }
  for (const ref of validated.kits.characters) {
    const kit = kits.characters.find((item) => item.characterId === ref.id);
    if (kit === undefined || kit.version !== ref.version) {
      problems.push(`character ${ref.id} v${ref.version} did not load as validated`);
    }
  }
  return check("kits_match_validated", problems.length === 0, {
    detail: problems.length === 0 ? "every kit is the version intake validated" : problems.join("; "),
  });
}

/** A deterministic plan id: a digest of the request and the shots' choices, so the same plan always has the same id. */
export function planIdFor(requestId: string, shots: readonly ShotSpec[]): string {
  const summary = shots.map((shot) => [shot.shotId, shot.visualType, shot.startMs, shot.endMs, shot.source.kind]);
  const digest = createHash("sha256").update(JSON.stringify([requestId, summary])).digest("hex");
  return `plan_${digest.slice(0, 24)}`;
}

/**
 * The first target of the 7.1 downgrade chain that this shot can take as it stands: its kit exists, its source can be built, a
 * product shot keeps its imagery, and a must it satisfies is kept. Undefined when no target qualifies, and the plan gate then
 * refuses the generated shot (generated_shots_have_downgrade).
 */
export function downgradeFor(visualType: VisualType, shot: ShotInput, kits: PlanKits): VisualType | undefined {
  const mustAllowed = mustAllowedTypes(shot.requests);
  for (const target of DOWNGRADE_TO[visualType]) {
    if (kitRejection(target, kits) !== null) continue;
    if (productPixelRejection(target, shot.flags.showsProduct, kits.productKit) !== null) continue;
    if (shot.refusals?.[target] !== undefined) continue;
    if (mustAllowed !== null && !mustAllowed.includes(target)) continue;
    return target;
  }
  return undefined;
}

/** The spoken words of one shot, each timed from the shot's start (the voice's spans), and its emphasis (from the script beat). */
type ShotText = { words: string[]; spans: WordSpan[]; emphasis: string[] };

function shotText(shot: ShotInput, input: PlanSceneInput): ShotText {
  const span = input.voice.beatSpans.find((item) => item.beatId === shot.beatId);
  if (span === undefined) {
    throw new EngineError("invalid_input", `beat ${shot.beatId} has no voice span`);
  }
  const beat = input.script.beats.find((item) => item.beatId === shot.beatId);
  const timed = timedWordsOfShot(input.voice.words, shot, span);
  const words = timed.map((word) => word.text);
  return {
    words,
    spans: timed.map((word) => ({ startMs: word.startMs, endMs: word.endMs })),
    emphasis: emphasisIn(words, beat?.emphasis ?? []),
  };
}

/** A refused plan: no plan, the checks that stopped it, and the shots at fault. */
function unbuilt(requestId: string, checks: GateCheck[], failingShotIds: string[], calls: RoleCall[], alerts: BudgetAlert[]): PlanSceneOutcome {
  return { gate: gateResult("plan", requestId, checks, failingShotIds), plan: null, calls, alerts };
}

/** The Opus planner call (6.4 step 4). The answer is returned, or the reason no answer was held. */
async function runPlanner(
  input: PlanSceneInput,
  shots: readonly PlannerShot[],
  style: StyleKit,
): Promise<{ answer: PlannerAnswer | null; reason: string; calls: RoleCall[]; alerts: BudgetAlert[] }> {
  const run = await runRole(input.deps, planner, {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    reservationId: input.reservationId,
    attempt: input.attempt,
    signal: input.signal,
    input: plannerTaskOf({
      styleKit: style,
      ...(input.kits.persona === undefined ? {} : { persona: input.kits.persona }),
      characters: input.kits.characters,
      ...(input.kits.productKit === undefined ? {} : { productKit: input.kits.productKit }),
      shots,
    }),
  });
  if (run.status === "done") return { answer: run.value, reason: "", calls: run.calls, alerts: run.alerts };
  if (run.status === "refused") {
    return { answer: null, reason: `the planner call was refused: ${run.reason}`, calls: run.calls, alerts: run.alerts };
  }
  return {
    answer: null,
    reason: "this planner call was already authorized, and its answer is not held in this run",
    calls: run.calls,
    alerts: run.alerts,
  };
}

/** The Opus director call (7.7). The answer is returned, or null with the reason. */
async function runDirector(
  input: PlanSceneInput,
  choices: readonly DirectorChoice[],
  reservedUsd: number,
  budgetUsd: number,
): Promise<{ answer: DirectorCheckAnswer | null; reason: string; calls: RoleCall[]; alerts: BudgetAlert[] }> {
  const shots: DirectorShot[] = choices.map((choice) => ({
    shotId: choice.shotId,
    beatRole: choice.beatRole,
    durationMs: choice.durationMs,
    visualType: choice.visualType,
    candidates: choice.candidates.map((candidate) => candidate.visualType),
    generated: choice.generated,
    ...(choice.prompt === null ? {} : { prompt: choice.prompt }),
    ...(choice.mustSatisfy === null ? {} : { mustSatisfy: choice.mustSatisfy }),
    showsProduct: choice.showsProduct,
    ...(choice.beatText === undefined ? {} : { beatText: choice.beatText }),
  }));
  const run = await runDirectorCheck(input.deps, {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    reservationId: input.reservationId,
    attempt: input.attempt,
    signal: input.signal,
    input: directorTaskOf({
      requestBudgetUsd: budgetUsd,
      reservedUsd,
      genome: input.dna.genome,
      ...(input.kits.persona === undefined ? {} : { persona: input.kits.persona }),
      shots,
    }),
  });
  if (run.status === "answered") {
    return { answer: run.answer, reason: "", calls: run.calls, alerts: run.alerts };
  }
  return { answer: null, reason: run.reason, calls: run.calls, alerts: run.alerts };
}

/**
 * Build the plan of one request (6.4). Returns a gate on every path; see the file header. Throws EngineError only for an input the
 * plan cannot read (a voice that does not tile, a request with no classification): those are data errors of the caller.
 */
/** The deterministic alignment of the beats to the reference and the voice (6.4 steps 1 and 2). No call is made. */
function alignmentFor(input: PlanSceneInput, limits: ShotLengthLimits): AlignOutput {
  return alignShots(
    {
      requestId: input.requestId,
      beats: input.script.beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, emphasis: beat.emphasis })),
      visualRequests: input.request.visualRequests,
      classifications: input.classifications,
      voice: { durationMs: input.voice.durationMs, beatSpans: input.voice.beatSpans, words: input.voice.words },
      reference: {
        durationMs: input.dna.durationMs,
        segments: input.dna.segments.map((segment) => ({
          segId: segment.segId,
          startMs: segment.startMs,
          endMs: segment.endMs,
          shotType: segment.shotType,
          ...(segment.beatRole === undefined ? {} : { beatRole: segment.beatRole }),
        })),
        shotLengthCurveMs: input.dna.editGrammar.shotLengthMs.curve,
      },
    },
    limits,
  );
}

/**
 * Rule 6 at build time (7.2): the component types this shot's own words, timings, kits and sheet cannot draw are refused, so the
 * filter never offers them. The same refusals serve the first plan and a downgrade replan.
 */
function withComponentRefusals(
  shot: ShotInput,
  text: ShotText,
  input: PlanSceneInput,
  productKit: ProductKit | undefined,
  rigSheet: CharacterSheet | undefined,
): ShotInput {
  const built = componentBuildRefusals({
    shot: {
      shotId: shot.shotId,
      durationMs: shot.endMs - shot.startMs,
      beatRole: shot.beatRole,
      showsProduct: shot.flags.showsProduct,
      words: text.words,
      emphasis: text.emphasis,
      spans: text.spans,
    },
    ...(input.kits.persona === undefined ? {} : { persona: input.kits.persona }),
    ...(productKit === undefined ? {} : { productKit }),
    ...(rigSheet === undefined ? {} : { character: rigSheet }),
    claimIds: input.request.product?.claimIds ?? [],
  });
  return { ...shot, refusals: { ...shot.refusals, ...built } };
}

export async function planScene(input: PlanSceneInput, limits: ShotLengthLimits = DEFAULT_SHOT_LENGTH): Promise<PlanSceneOutcome> {
  const requestId = input.request.requestId;
  const calls: RoleCall[] = [];
  const alerts: BudgetAlert[] = [];
  const kitChecks = [kitMatchCheck(input.validated, input.kits)];
  const style = input.kits.styleKit;
  if (style === undefined) {
    return unbuilt(requestId, [...kitChecks, check("style_kit_loaded", false, { detail: "the style kit did not load, so the plan has no style" })], [], calls, alerts);
  }

  // Steps 1 and 2 (6.4): align the beats to the reference and split them into shots.
  const aligned: AlignOutput = alignmentFor(input, limits);
  const productKit = input.kits.productKit;
  const hero = productKit === undefined ? null : heroUriOf(productKit);
  const planKits = planKitsOf(input.kits);
  const budgetUsd = input.request.constraints.budgetUsd;
  const rigSheet = rigSheetOf(input.kits.characters);

  // Rule 6 at build time (7.2): a component type this shot's own words, timings, kits and sheet cannot draw is refused before
  // the planner writes anything, so the filter never offers it and the plan does not fail later at sources_built.
  const textsById = new Map(aligned.shots.map((shot) => [shot.shotId, shotText(shot, input)]));
  const refusableShots: ShotInput[] = aligned.shots.map((shot) => {
    const text = textsById.get(shot.shotId);
    if (text === undefined) throw new EngineError("internal", `shot ${shot.shotId} has no text`);
    return withComponentRefusals(shot, text, input, productKit, rigSheet);
  });
  const shotsById = new Map(refusableShots.map((shot) => [shot.shotId, shot]));

  // Steps 3 and 4 (7.5, 7.6): score every candidate and fit the budget.
  const decided: VisualDecisionResult = decideVisuals({
    shots: refusableShots,
    styleKit: { preferredTypes: style.preferredTypes, bannedTypes: style.bannedTypes },
    kits: planKits,
    requestBudgetUsd: budgetUsd,
  });
  if (decided.unfilled.length > 0) {
    const detail = `no candidate survives the filter for ${decided.unfilled.length} shot(s)`;
    return unbuilt(requestId, [...kitChecks, check("every_shot_has_a_candidate", false, { detail })], decided.unfilled, calls, alerts);
  }
  if (!decided.totals.fitsBudget) {
    const detail = `the cheapest candidates reserve ${decided.totals.reservedUsd} USD, above the budget ${budgetUsd} USD`;
    return unbuilt(
      requestId,
      [...kitChecks, check("shots_fit_budget", false, { value: decided.totals.reservedUsd, limit: budgetUsd, detail })],
      [],
      calls,
      alerts,
    );
  }

  // Step 4, the writing (planner, one Opus call): a prompt for each shot that may be generated, a query for each that may be stock.
  const plannerShots: PlannerShot[] = [];
  for (const choice of decided.shots) {
    const shot = shotsById.get(choice.shotId);
    if (shot === undefined) throw new EngineError("internal", `shot ${choice.shotId} is missing from the alignment`);
    const types = choice.candidates.map((candidate) => candidate.visualType);
    const prompt = needsPrompt(choice.candidates);
    const query = needsQuery(types);
    if (!prompt && !query) continue;
    plannerShots.push({
      shotId: shot.shotId,
      durationMs: shot.endMs - shot.startMs,
      beatRole: shot.beatRole,
      wants: shot.requests.map((request) => request.want),
      candidates: types,
      prompt,
      query,
      showsProduct: shot.flags.showsProduct,
      pinnedFrame: shot.flags.showsProduct && hero !== null,
    });
  }
  const texts = new Map<string, { prompt?: string; query?: string }>();
  if (plannerShots.length > 0) {
    const written = await runPlanner(input, plannerShots, style);
    calls.push(...written.calls);
    alerts.push(...written.alerts);
    if (written.answer === null) {
      return unbuilt(requestId, [...kitChecks, check("planner_answered", false, { detail: written.reason })], [], calls, alerts);
    }
    for (const entry of written.answer.shots) {
      texts.set(entry.shotId, {
        ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
        ...(entry.query === undefined ? {} : { query: entry.query }),
      });
    }
  }

  // Step 5 (director, one Opus call): swaps inside the candidates and the budget, and prompt edits. Both are checked in code.
  const initial: DirectorChoice[] = decided.shots.map((choice: ShotChoice) => {
    const shot = shotsById.get(choice.shotId);
    if (shot === undefined || choice.visualType === null || choice.baseUsd === null || choice.score === null) {
      throw new EngineError("internal", `shot ${choice.shotId} has no choice after the fit`);
    }
    return {
      shotId: shot.shotId,
      beatRole: shot.beatRole,
      durationMs: shot.endMs - shot.startMs,
      showsProduct: shot.flags.showsProduct,
      mustSatisfy: choice.mustSatisfy,
      beatText: input.script.beats.find((beat) => beat.beatId === shot.beatId)?.text,
      visualType: choice.visualType,
      generated: choice.generated,
      baseUsd: choice.baseUsd,
      score: choice.score,
      candidates: choice.candidates,
      prompt: texts.get(shot.shotId)?.prompt ?? null,
    };
  });
  const directed = await runDirector(input, initial, decided.totals.reservedUsd, budgetUsd);
  calls.push(...directed.calls);
  alerts.push(...directed.alerts);
  if (directed.answer === null) {
    return unbuilt(requestId, [...kitChecks, check("director_answered", false, { detail: directed.reason })], [], calls, alerts);
  }
  const applied = applyDirectorCheck({ choices: initial, requestBudgetUsd: budgetUsd, answer: directed.answer });

  // Step 4, the sources, now that every type is final: component props, stock queries, generation prompts and the pinned frame.
  const failingShots: string[] = [];
  const reasons: string[] = [];
  const sourced = applied.choices.map((choice) => {
    const shot = shotsById.get(choice.shotId);
    if (shot === undefined) throw new EngineError("internal", `shot ${choice.shotId} is missing`);
    const text = textsById.get(shot.shotId);
    if (text === undefined) throw new EngineError("internal", `shot ${shot.shotId} has no text`);
    const query = texts.get(shot.shotId)?.query;
    const result = buildSource({
      visualType: choice.visualType,
      shot: {
        shotId: shot.shotId,
        durationMs: choice.durationMs,
        beatRole: shot.beatRole,
        showsProduct: shot.flags.showsProduct,
        words: text.words,
        emphasis: text.emphasis,
        spans: text.spans,
      },
      ...(choice.prompt === null ? {} : { prompt: choice.prompt }),
      ...(query === undefined ? {} : { query }),
      ...(input.kits.persona === undefined ? {} : { persona: input.kits.persona }),
      ...(productKit === undefined ? {} : { productKit }),
      ...(rigSheet === undefined ? {} : { character: rigSheet }),
      claimIds: input.request.product?.claimIds ?? [],
    });
    if (!result.ok) {
      failingShots.push(shot.shotId);
      reasons.push(`${shot.shotId} (${choice.visualType}): ${result.reason}`);
    }
    return { choice, shot, result };
  });
  if (failingShots.length > 0) {
    return unbuilt(requestId, [...kitChecks, check("sources_built", false, { detail: reasons.join("; ") })], failingShots, calls, alerts);
  }

  // Assemble the plan. Every generated shot names its fallback (6.4 step 5). A shot whose type has a 7.1 fallback names it too (for
  // example stock_footage, and cartoon_rigged, which falls back to kinetic_type); downgradeFor keeps only a target the shot can take.
  const shots: ShotSpec[] = sourced.map(({ choice, shot, result }) => {
    if (!result.ok) throw new EngineError("internal", "a shot reached assembly without a source");
    const downgradeTo = downgradeFor(choice.visualType, shot, planKits);
    const layer: ShotLayer = result.built.layer;
    const source: ShotSource = result.built.source;
    return {
      shotId: shot.shotId,
      beatId: shot.beatId,
      startMs: shot.startMs,
      endMs: shot.endMs,
      visualType: choice.visualType,
      layer,
      source,
      ...(choice.mustSatisfy === null ? {} : { mustSatisfy: choice.mustSatisfy }),
      ...(downgradeTo === undefined ? {} : { downgradeTo }),
    };
  });
  const totals = planTotals(applied.choices.map((choice) => ({ baseUsd: choice.baseUsd, generated: choice.generated })));
  const decisions: Decision[] = [...alignmentDecisions(aligned), ...decided.decisions, ...applied.decisions];
  const plan: ScenePlan = {
    schema: "meridian.scene_plan/v1",
    planId: planIdFor(requestId, shots),
    requestId,
    videoDnaId: input.dna.videoDnaId,
    voiceTrackId: input.voice.voiceTrackId,
    shots,
    estimatedUsd: totals.shotsUsd,
    decisions,
  };

  // Step 7: the plan gate (12.1), with the handler's checks in front of it.
  const gated = checkPlan({
    plan,
    voice: input.voice,
    request: input.request,
    classifications: input.classifications,
    productImageUris: productKit === undefined ? undefined : productImageUris(productKit),
    productBeatIds: [...new Set(shots.filter((shot) => shotsById.get(shot.shotId)?.flags.showsProduct).map((shot) => shot.beatId))],
  });
  const handlerChecks: GateCheck[] = [
    ...kitChecks,
    check("planner_answered", true, {
      detail: plannerShots.length > 0 ? `${plannerShots.length} shot(s) written by the planner` : "no shot needs a written text",
    }),
    check("director_answered", true, {
      detail: `director: ${applied.swapsApplied} swap(s) applied, ${applied.swapsIgnored} ignored; ${applied.editsApplied} prompt edit(s) applied, ${applied.editsIgnored} ignored`,
    }),
    check("sources_built", true, { detail: `${shots.length} shot(s) built` }),
  ];
  const gate = gateResult("plan", plan.planId, [...handlerChecks, ...gated.checks], gated.failingShotIds ?? []);
  return { gate, plan, calls, alerts };
}

/** One downgrade replan (Bible 5.3): the plan it changes, and the one generated shot the directive names. */
export type DowngradeReplanInput = PlanSceneInput & { previous: ScenePlan; shotId: string };

export type DowngradeReplanOutcome = {
  /** Passes only when the named shot is rebuilt and the plan gate passes with it, within the plan's estimate (12.1). */
  gate: GateResult;
  /** The replanned plan, or null when the shot could not be replanned. A replanned plan may still fail its gate, and is then kept for review. */
  plan: ScenePlan | null;
  /** The replanned shot, or null when none was built. */
  shot: ShotSpec | null;
  calls: RoleCall[];
  alerts: BudgetAlert[];
};

function replanRefused(requestId: string, shotId: string, reason: string, calls: RoleCall[], alerts: BudgetAlert[]): DowngradeReplanOutcome {
  return {
    gate: gateResult("plan", requestId, [check("downgrade_built", false, { detail: reason })], [shotId]),
    plan: null,
    shot: null,
    calls,
    alerts,
  };
}

/**
 * A downgrade replan (Bible 5.3, 7.1). A generated shot whose take could not be made moves to the first target of its 7.1 chain that the
 * shot can take now. Only that shot changes: every other shot, its source and the voice stay as the previous plan has them. The target is
 * chosen by the same rules as a first plan (downgradeFor). A target that needs written text gets one planner call, for this shot only;
 * a component or a zero-cost target gets none. The shot is repriced, and the plan gate runs on the whole new plan. The replan keeps the
 * plan's estimate: a downgrade that costs more than the estimate fails the gate and is not written as passing.
 */
export async function replanDowngrade(input: DowngradeReplanInput, limits: ShotLengthLimits = DEFAULT_SHOT_LENGTH): Promise<DowngradeReplanOutcome> {
  const requestId = input.request.requestId;
  const calls: RoleCall[] = [];
  const alerts: BudgetAlert[] = [];
  const shotId = input.shotId;
  const named = input.previous.shots.find((shot) => shot.shotId === shotId);
  if (named === undefined) return replanRefused(requestId, shotId, `shot ${shotId} is not in the plan`, calls, alerts);
  if (DOWNGRADE_TO[named.visualType].length === 0) {
    return replanRefused(requestId, shotId, `${shotId} is ${named.visualType}, which names no downgrade target in 7.1`, calls, alerts);
  }
  const style = input.kits.styleKit;
  if (style === undefined) return replanRefused(requestId, shotId, "the style kit did not load, so the replan has no style", calls, alerts);

  const aligned = alignmentFor(input, limits);
  const alignedShot = aligned.shots.find((shot) => shot.shotId === shotId);
  if (alignedShot === undefined) return replanRefused(requestId, shotId, `the reference no longer aligns ${shotId}`, calls, alerts);
  const productKit = input.kits.productKit;
  const hero = productKit === undefined ? null : heroUriOf(productKit);
  const rigSheet = rigSheetOf(input.kits.characters);
  const planKits = planKitsOf(input.kits);
  const text = shotText(alignedShot, input);
  const refusable = withComponentRefusals(alignedShot, text, input, productKit, rigSheet);
  const target = downgradeFor(named.visualType, refusable, planKits);
  if (target === undefined) {
    return replanRefused(requestId, shotId, `no target of the 7.1 chain for ${named.visualType} is open to ${shotId} now`, calls, alerts);
  }

  const durationMs = named.endMs - named.startMs;
  // A target that needs written text gets one planner call for this shot, with the same answer shape as the first plan.
  const prompt = needsPrompt([{ generated: isGeneratedType(target) }]);
  const query = needsQuery([target]);
  let written: { prompt?: string; query?: string } = {};
  if (prompt || query) {
    const answer = await runPlanner(
      input,
      [
        {
          shotId,
          durationMs,
          beatRole: refusable.beatRole,
          wants: refusable.requests.map((request) => request.want),
          candidates: [target],
          prompt,
          query,
          showsProduct: refusable.flags.showsProduct,
          pinnedFrame: refusable.flags.showsProduct && hero !== null,
        },
      ],
      style,
    );
    calls.push(...answer.calls);
    alerts.push(...answer.alerts);
    if (answer.answer === null) return replanRefused(requestId, shotId, answer.reason, calls, alerts);
    const entry = answer.answer.shots.find((item) => item.shotId === shotId);
    if (prompt && entry?.prompt === undefined) return replanRefused(requestId, shotId, `the planner wrote no prompt for ${shotId}`, calls, alerts);
    if (query && entry?.query === undefined) return replanRefused(requestId, shotId, `the planner wrote no query for ${shotId}`, calls, alerts);
    written = {
      ...(entry?.prompt === undefined ? {} : { prompt: entry.prompt }),
      ...(entry?.query === undefined ? {} : { query: entry.query }),
    };
  }

  const result = buildSource({
    visualType: target,
    shot: {
      shotId,
      durationMs,
      beatRole: refusable.beatRole,
      showsProduct: refusable.flags.showsProduct,
      words: text.words,
      emphasis: text.emphasis,
      spans: text.spans,
    },
    ...(written.prompt === undefined ? {} : { prompt: written.prompt }),
    ...(written.query === undefined ? {} : { query: written.query }),
    ...(input.kits.persona === undefined ? {} : { persona: input.kits.persona }),
    ...(productKit === undefined ? {} : { productKit }),
    ...(rigSheet === undefined ? {} : { character: rigSheet }),
    claimIds: input.request.product?.claimIds ?? [],
  });
  if (!result.ok) return replanRefused(requestId, shotId, `${shotId} (${target}): ${result.reason}`, calls, alerts);

  const next = downgradeFor(target, refusable, planKits);
  const replacement: ShotSpec = {
    shotId,
    beatId: named.beatId,
    startMs: named.startMs,
    endMs: named.endMs,
    visualType: target,
    layer: result.built.layer,
    source: result.built.source,
    ...(named.mustSatisfy === undefined ? {} : { mustSatisfy: named.mustSatisfy }),
    ...(next === undefined ? {} : { downgradeTo: next }),
  };
  const shots = input.previous.shots.map((shot) => (shot.shotId === shotId ? replacement : shot));

  // Reprice every shot from the price table. A shot with no known price fails closed, as the first plan does.
  const lines: PlanLine[] = [];
  for (const shot of shots) {
    const cost = shotCost(shot.visualType, shot.endMs - shot.startMs);
    if (!cost.known) return replanRefused(requestId, shot.shotId, `${shot.shotId} (${shot.visualType}) has no known price: ${cost.reason}`, calls, alerts);
    lines.push({ baseUsd: cost.baseUsd, generated: cost.generated });
  }
  const totals = planTotals(lines);
  const decision: Decision = {
    at: `shot:${shotId}`,
    chose: target,
    alternatives: [],
    reason: `Downgrade replan: ${named.visualType} could not be made, so ${shotId} moves to ${target}, the first target of its 7.1 chain it can take now.`,
    by: "scorer",
  };
  const plan: ScenePlan = {
    ...input.previous,
    planId: planIdFor(requestId, shots),
    shots,
    estimatedUsd: totals.shotsUsd,
    decisions: [...input.previous.decisions, decision],
  };

  const alignedById = new Map(aligned.shots.map((shot) => [shot.shotId, shot]));
  const gated = checkPlan({
    plan,
    voice: input.voice,
    request: input.request,
    classifications: input.classifications,
    productImageUris: productKit === undefined ? undefined : productImageUris(productKit),
    productBeatIds: [...new Set(plan.shots.filter((shot) => alignedById.get(shot.shotId)?.flags.showsProduct === true).map((shot) => shot.beatId))],
  });
  const withinEstimate = totals.shotsUsd <= input.previous.estimatedUsd;
  const handlerChecks: GateCheck[] = [
    check("downgrade_built", true, {
      detail: `${shotId}: ${named.visualType} to ${target}; ${calls.length} planner call(s) for this shot`,
    }),
    check("replan_within_estimate", withinEstimate, {
      value: totals.shotsUsd,
      limit: input.previous.estimatedUsd,
      detail: withinEstimate ? "the replanned shots cost no more than the plan's estimate" : "the downgrade costs more than the plan's estimate",
    }),
  ];
  const gate = gateResult("plan", plan.planId, [...handlerChecks, ...gated.checks], gated.failingShotIds ?? []);
  return { gate, plan, shot: replacement, calls, alerts };
}
