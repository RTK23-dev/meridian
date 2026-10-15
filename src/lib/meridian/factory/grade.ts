/**
 * The JEV grade for one Factory item (NORTH_STAR section 5, grade). The observed signal is the winner score that gradeStoredAds stores.
 * This module adds the engine's grade beside it, and never blends the two into one number. The grade is runEngineGate with the run's
 * engine on the five grading questions. Each question is asked under its registry spec, and sees only the evidence in its own scope.
 *
 * No engine ready for the workspace means the item is graded on observed signal only, and the grade says so. An engine that answers
 * with a refusal or a failure is still an engine: its answer, or its absence, goes to review through the gate.
 */

import type { Sql } from "../learning/store.ts";
import { runEngineGate, type GateEvidenceInput, type GateQuestion, type GateResult } from "../decisions/gate.ts";
import { createDecisionEngines, type DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { AppliedCalibration, PolicyOutcome } from "../decisions/policy.ts";
import { resolveActiveEngine, type EngineSelection } from "../decisions/selection.ts";
import type { DecisionEngineId, DecisionUsage } from "../decisions/types.ts";
import type { JevQuestionSpec } from "../jev/types.ts";
import { BRAND_QUESTIONS } from "../jev/questions/brand.ts";
import { CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";
import { MARKET_QUESTIONS } from "../jev/questions/market.ts";
import { PRODUCTION_QUESTIONS } from "../jev/questions/production.ts";
import { SAFETY_QUESTIONS } from "../jev/questions/safety.ts";
import type { BrainKey } from "../brain.ts";
import type { DecisionEngineChoice } from "./run-settings.ts";
import type { CreativeDna } from "./creative-dna.ts";
import { templateFromDna } from "./template.ts";

/** The stored grade's reason when no engine is ready for the workspace. The wording is fixed, so a reader can tell it from a decision. */
export const NO_ENGINE_GRADE = "graded on observed signal only: no decision engine configured";

/** The stored grade's reason when an ad has no creative DNA, so there is no concept to put to an engine. */
export const NO_DNA_GRADE = "graded on observed signal only: no creative DNA is stored for this ad";

/**
 * The stored grade's reason when the run's caps or the kill switch refuse this ad's engine call. `stop` is the reason the call was
 * refused, the same text the stage check gives. The ad keeps its observed signal, and it is graded again once the stop is cleared.
 */
export function cappedGradeReason(stop: string): string {
  return `graded on observed signal only, because the engine call was refused. ${stop}`;
}

const GATE_NAME = "factory_grade";

const GRADE_DESCRIPTION =
  "A Factory item: a stored ad read as a creative concept. Judge only the concept and the brand facts given. The stored copy is " +
  "evidence for the risk question alone, and no question may repeat it.";

/**
 * The five grading questions, by the name the Factory uses for them, each with the registry spec it is asked under. The specs are
 * versioned in the registry, so a grade records the versions it was asked under.
 */
export const GRADING_QUESTIONS: ReadonlyArray<{ key: string; spec: JevQuestionSpec }> = [
  { key: "competitive_strength", spec: MARKET_QUESTIONS["market.competitive_strength.v1"] },
  { key: "reproducibility", spec: PRODUCTION_QUESTIONS["production.reproducibility.v1"] },
  { key: "brand_fit", spec: CREATIVE_QUESTIONS["creative.brand_fit.v1"] },
  { key: "positioning_fit", spec: BRAND_QUESTIONS["brand.positioning_fit.v1"] },
  { key: "risk_safety", spec: SAFETY_QUESTIONS["safety.policy_risk_level.v1"] },
];

export function gradingQuestionVersions(): string[] {
  return GRADING_QUESTIONS.map((question) => `${question.spec.id}@${question.spec.version}`);
}

export type GradeEngineChoice = {
  decisionEngine: DecisionEngineChoice;
  /** The selection the caller already resolved. Absent, the run's choice or the workspace's engine is resolved here. */
  selection?: EngineSelection;
  /** Transport registry for the engines. Absent, the live engines are built. */
  engines?: DecisionEngineRegistry;
};

/** The engine a run grades with, once it is ready for the workspace. */
export type GradeEngine = {
  selection: EngineSelection;
  engines: DecisionEngineRegistry;
  questionVersions: string[];
};

/**
 * The engine that grades this run's items, or null when none is ready. Ready means the engine reports READY for the workspace.
 * A run's own choice names its engine. The workspace default is the engine the workspace selected, as decisions always resolve it.
 */
export async function resolveGradeEngine(sql: Sql, organizationId: string, choice: GradeEngineChoice): Promise<GradeEngine | null> {
  let selection: EngineSelection;
  if (choice.selection) selection = choice.selection;
  else if (choice.decisionEngine === "workspace_default") selection = await resolveActiveEngine(sql, organizationId);
  else selection = { engineId: choice.decisionEngine, source: "run" };
  const engines = choice.engines ?? createDecisionEngines();
  const engine = engines[selection.engineId];
  if (!engine) return null;
  try {
    const health = engine.healthFor ? await engine.healthFor(organizationId) : await engine.health();
    if (health.status !== "READY") return null;
  } catch {
    return null;
  }
  return { selection, engines, questionVersions: gradingQuestionVersions() };
}

export type GradeVote = {
  question: string;
  questionId: string;
  /** A policy outcome for a vote, or "unresolved:<status>" for a question that gave no usable answer. */
  outcome: string;
  reason: string;
  calibrationStatus: string;
  /** Present when the vote was made under the brand's calibrated threshold: the report, its sample size and the threshold. */
  calibration?: AppliedCalibration;
};

export type ItemGrade =
  | { status: "observed_only"; reason: string }
  | {
      status: "engine";
      action: PolicyOutcome;
      reason: string;
      engineId: DecisionEngineId;
      model: string | null;
      questionVersions: string[];
      policyVersion: string;
      gateRecordId: string | null;
      votes: GradeVote[];
      /** Whether the gate called the engine. A grade answered from the engine's own record did not, and spent nothing. */
      engineCalled: boolean;
      /** The model asked for, and the model the provider reported. Both are needed to price the tokens. */
      requestedModel: string | null;
      returnedModel: string | null;
      /** The token usage the engine reported over the grade's calls. Null when the engine reports none. */
      usage: DecisionUsage | null;
    };

/** The stored form of a grade, one value per jev_* column of ad_timelines. */
export type GradeColumns = {
  status: "engine" | "observed_only";
  action: PolicyOutcome | null;
  reason: string;
  engineId: string | null;
  model: string | null;
  questionVersions: string;
  policyVersion: string;
  gateRecordId: string | null;
  votes: string;
};

export function observedOnlyGrade(reason: string): ItemGrade {
  return { status: "observed_only", reason };
}

export function gradeColumnsOf(grade: ItemGrade): GradeColumns {
  if (grade.status === "observed_only") {
    return {
      status: "observed_only",
      action: null,
      reason: grade.reason,
      engineId: null,
      model: null,
      questionVersions: "[]",
      policyVersion: "",
      gateRecordId: null,
      votes: "[]",
    };
  }
  return {
    status: "engine",
    action: grade.action,
    reason: grade.reason,
    engineId: grade.engineId,
    model: grade.model,
    questionVersions: JSON.stringify(grade.questionVersions),
    policyVersion: grade.policyVersion,
    gateRecordId: grade.gateRecordId,
    votes: JSON.stringify(grade.votes),
  };
}

/** What the grade stage knows about one ad. Every field is read from storage; none is estimated. */
export type GradeItem = {
  researchAdId: string;
  /** The ad's stored copy. It is evidence for the risk question only. */
  copy: string;
  /** The ad's creative DNA. An ad with none has no concept to put to an engine, and is graded on observed signal only. */
  dna: CreativeDna;
  /** Stored creatives of the same niche and brand scope, counted from creative DNA. */
  market: { storedCreatives: number; sameAngle: number; sameAngleAdvertisers: number };
  /** The brand's own creatives, from creative records. */
  brand: { creatives: number; sameAngle: number };
  brain: Record<BrainKey, string>;
};

function evidenceOf(item: GradeItem): GateEvidenceInput[] {
  const dna = item.dna;
  const concept = {
    format: dna.format.value,
    hookType: dna.hook.type.value,
    angle: dna.angle.value,
    beats: dna.beats.map((beat) => beat.role),
    durationMs: dna.durationMs,
  };
  const items: GateEvidenceInput[] = [
    { kind: "text", name: "concept_spec", source: "creative_dna", content: concept },
    // The concept's framing, without the copy. Brand fit judges the framing against the brand's positioning.
    { kind: "text", name: "creative_copy", source: "creative_dna", content: { angle: concept.angle, hookType: concept.hookType, format: concept.format } },
    // The storyboard holds the framework only: beat roles, shot types and placeholder voiceover, never the ad's own lines.
    { kind: "text", name: "workflow_template", source: "factory_template", content: templateFromDna(dna) },
    { kind: "text", name: "brand_creatives", source: "creative_records", content: item.brand },
  ];
  if (item.market.storedCreatives > 0) {
    items.push({ kind: "text", name: "competitor_creatives", source: "research_ads", content: item.market });
  }
  const brain = item.brain;
  // Positioning is a required brain field. Without it, the positioning questions have no basis and abstain.
  if (brain.positioning.trim()) {
    items.push({
      kind: "text",
      name: "brand_positioning",
      source: "brand_brain",
      content: { positioning: brain.positioning, valueProposition: brain.valueProposition, tone: brain.tone },
    });
    items.push({
      kind: "text",
      name: "brand_brain",
      source: "brand_brain",
      content: {
        positioning: brain.positioning,
        differentiators: brain.differentiators,
        targetCustomers: brain.targetCustomers,
        tone: brain.tone,
        wordsToAvoid: brain.wordsToAvoid,
        prohibitedClaims: brain.prohibitedClaims,
        requiredDisclaimers: brain.requiredDisclaimers,
        requiredClaims: brain.requiredClaims,
      },
    });
  }
  if (item.copy.trim()) {
    items.push({ kind: "text", name: "script", source: "research_ads", content: { copy: item.copy } });
  }
  return items;
}

/** One item's grade from the engine: one gate decision, with one engine call per evidence scope. The gate persists its record. */
export async function gradeItemWithEngine(
  sql: Sql,
  input: { organizationId: string; brandId: string; item: GradeItem },
  engine: GradeEngine,
): Promise<ItemGrade> {
  const questions: GateQuestion[] = GRADING_QUESTIONS.map((question) => ({
    key: question.key,
    spec: question.spec,
    needsImage: false,
    evidenceScope: question.spec.evidenceRequirements,
  }));
  const gate: GateResult = await runEngineGate({
    sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: GATE_NAME,
    subject: { type: "research_ad", id: input.item.researchAdId },
    description: GRADE_DESCRIPTION,
    questions,
    evidence: evidenceOf(input.item),
    selection: engine.selection,
    engines: engine.engines,
  });
  const keyOfSpec = new Map(GRADING_QUESTIONS.map((question) => [question.spec.id, question.key]));
  const votes: GradeVote[] = [
    ...gate.votes.map((vote) => ({
      question: keyOfSpec.get(vote.questionId) ?? vote.questionId,
      questionId: vote.questionId,
      outcome: vote.outcome,
      reason: vote.reason,
      calibrationStatus: vote.calibrationStatus,
      ...(vote.calibration ? { calibration: vote.calibration } : {}),
    })),
    ...gate.unresolved.map((item) => ({
      question: keyOfSpec.get(item.questionId) ?? item.questionId,
      questionId: item.questionId,
      outcome: `unresolved:${item.status}`,
      reason: item.reason,
      calibrationStatus: item.calibrationStatus,
    })),
  ];
  return {
    status: "engine",
    action: gate.action,
    reason: gate.reason,
    engineId: gate.engineId ?? engine.selection.engineId,
    model: gate.returnedModel ?? gate.model,
    questionVersions: gate.questionVersions,
    policyVersion: gate.policyVersion,
    gateRecordId: gate.gateRecordId,
    votes,
    engineCalled: gate.engineCalled,
    requestedModel: gate.requestedModel,
    returnedModel: gate.returnedModel,
    usage: gate.usage ?? null,
  };
}
