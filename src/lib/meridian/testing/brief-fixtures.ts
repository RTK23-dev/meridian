/**
 * Shared fixtures for brief tests: a counting stub decision engine, the brief and brand facts, and a helper that writes a
 * brief through the real gate and writer, so tests exercise the same path production does.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { BRIEF_QUESTIONS } from "../jev/questions/brief.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest, type DecisionResult } from "../decisions/types.ts";
import type { EngineSelection } from "../decisions/selection.ts";
import { createGatedBrief } from "../studio/brief-service.server.ts";
import { briefDeterministicRejections, judgeBriefFit, type BriefBrain, type BriefForGate, type BriefGateResult } from "../studio/brief-gate.server.ts";

export const BRIEF: BriefForGate = {
  audience: "Busy parents",
  hook: "Dinner on the table in ten minutes",
  message: "A calm dinner plan that needs no planning",
  format: "video",
  cta: "See it in use",
  angle: "dinner in ten minutes",
};

export const BRAIN: BriefBrain = {
  positioning: "Helps busy parents plan a calm dinner in ten minutes.",
  valueProposition: "Planned dinners with no planning.",
  tone: "warm",
  prohibitedClaims: "guaranteed",
  wordsToAvoid: "",
};

export const BRAND_QUESTION = BRIEF_QUESTIONS["brief.brand_fit.v1"]!.id;
export const OPPORTUNITY_QUESTION = BRIEF_QUESTIONS["brief.opportunity_fit.v1"]!.id;
export const CLAIM_QUESTION = BRIEF_QUESTIONS["brief.claim_compliance.v1"]!.id;

export type StubResponder = (spec: JevQuestionSpec) => JevAnswer | undefined;

export function answeredProbability(spec: JevQuestionSpec, probability: number): JevAnswer {
  return {
    questionId: spec.id,
    questionVersion: spec.version,
    type: spec.type,
    model: "stub-model",
    provider: "stub",
    status: "answered",
    answer: probability >= 0.5,
    probability,
    noul: probability,
    semantics: "probability",
    calibrationStatus: "uncalibrated",
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  } as JevAnswer;
}

/**
 * The same probability, reported as calibrated. Only a calibrated probability can approve or reject (contract section 6).
 * The engines report uncalibrated values today, so a test that is about approval or rejection must say it is calibrated.
 */
export function calibratedProbability(spec: JevQuestionSpec, probability: number): JevAnswer {
  return { ...answeredProbability(spec, probability), calibrationStatus: "calibrated" } as JevAnswer;
}

/** Answers every brief question as a clear approval, as the engines report it today: uncalibrated, so held for review. */
export const approvesBrief: StubResponder = (spec) => {
  if (spec.id === BRAND_QUESTION || spec.id === OPPORTUNITY_QUESTION) return answeredProbability(spec, 0.95);
  if (spec.id === CLAIM_QUESTION) return answeredProbability(spec, 0.99);
  return undefined;
};

/** Answers every brief question as a calibrated approval. Used where a test is about an automatic approval. */
export const approvesBriefCalibrated: StubResponder = (spec) => {
  if (spec.id === BRAND_QUESTION || spec.id === OPPORTUNITY_QUESTION) return calibratedProbability(spec, 0.95);
  if (spec.id === CLAIM_QUESTION) return calibratedProbability(spec, 0.99);
  return undefined;
};

/** A counting stub engine. It records every request it receives, so tests can prove which engine was called and how often. */
export function stubEngine(id: DecisionEngineId, options: { respond?: StubResponder; failure?: boolean } = {}) {
  const requests: DecisionRequest[] = [];
  const engine: DecisionEngine = {
    id,
    adapterVersion: `${id}-stub.v1`,
    capabilities: () => ({
      engineId: id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: id === "openai-decisions" ? ["text", "image"] : ["text"],
      maxImages: id === "openai-decisions" ? 128 : 0,
      maxImageBytes: 20 * 1024 * 1024,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request) => {
      requests.push(request);
      const failure = options.failure ? { kind: "provider_unavailable" as const, message: "stub outage" } : undefined;
      const answers: Record<string, JevAnswer> = options.failure
        ? abstainAll(request, { status: "provider_error", reason: "stub outage", model: "stub-model", provider: id })
        : {};
      if (!options.failure) {
        for (const [key, spec] of Object.entries(request.questions)) {
          const answer = options.respond?.(spec);
          if (answer) answers[key] = answer;
        }
      }
      const result: DecisionResult = {
        runId: randomUUID(),
        model: "stub-model",
        provider: id,
        inputHash: "stub-hash",
        cached: false,
        latencyMs: 2,
        answers,
        engineId: id,
        adapterVersion: engine.adapterVersion,
        requestedModel: "stub-model",
        returnedModel: "stub-model",
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
        failure,
      };
      return result;
    },
  };
  return { engine, requests };
}

export const registryWith = (
  jev: ReturnType<typeof stubEngine>,
  openai: ReturnType<typeof stubEngine>,
): DecisionEngineRegistry => ({ jev: jev.engine, "openai-decisions": openai.engine });

/**
 * Creates a brief through the real path: the shared gate judges it, and `createGatedBrief` writes the decision and the brief
 * row with the status its outcome gives. Returns the ids and the gate outcome, so a test reads the stored state the way
 * production does.
 */
export async function createBrief(
  sql: Sql,
  tenant: { organizationId: string; brandId: string; userId: string },
  options: { engines: DecisionEngineRegistry; selected: EngineSelection; brief?: BriefForGate; creatorId?: string },
) {
  const brief = options.brief ?? BRIEF;
  const outcome: { result?: BriefGateResult } = {};
  const created = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: options.creatorId ?? tenant.userId,
    brief: {
      opportunityId: null,
      title: `Fixture brief ${brief.angle}`,
      audience: brief.audience,
      angle: brief.angle,
      hook: brief.hook,
      message: brief.message,
      offer: brief.offer ?? "",
      cta: brief.cta,
      format: brief.format,
      proofType: "",
      constraints: "",
      context: {},
      workflow: "test",
      why: [],
      learningNotes: [],
      failureNotes: [],
    },
    judge: async (briefId) => {
      outcome.result = await judgeBriefFit({
        sql,
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        briefId,
        brief,
        brain: BRAIN,
        engines: options.engines,
        selection: options.selected,
      });
      return outcome.result;
    },
  });
  const result = outcome.result!;
  return {
    briefId: created.briefId,
    decisionId: created.decisionId,
    action: created.action,
    gateRecordId: result.gateRecordId,
    result,
    deterministicRejections: briefDeterministicRejections(brief, BRAIN),
  };
}
