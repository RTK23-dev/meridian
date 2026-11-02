/**
 * A fixture decision engine for the tests. It implements the DecisionEngine contract (decisions/types.ts), so the engine gate runs
 * over it exactly as it runs over the live engines. It makes no request, keeps every request it was given, and answers from a
 * responder the test supplies.
 *
 * Its answers have the shape the engines return:
 * - a predicate answer carries a probability, the TypeSafe System One noul primitive that decisions/jev-engine.ts maps;
 * - a choice answer carries one choice and its confidence, the choice primitive.
 * The TypeSafe JEV transport is documented in docs/PROVIDERS.md. The OpenAI Decisions answer shape follows the OpenAI API reference
 * at https://platform.openai.com/docs/api-reference (see decisions/openai-engine.ts).
 */

import type {
  DecisionCapabilities,
  DecisionEngine,
  DecisionEngineHealth,
  DecisionEngineId,
  DecisionRequest,
  DecisionResult,
  DecisionUsage,
} from "../../../../lib/meridian/decisions/types.ts";
import type { JevAnswer, JevQuestionSpec } from "../../../../lib/meridian/jev/types.ts";

export type FixtureAnswer = { probability: number } | { choice: string; confidence?: number } | "abstain";

export type FixtureEngineOptions = {
  /** The engine id the fixture answers as. Default "jev". */
  id?: DecisionEngineId;
  /** The model name the answers report. It is a fixture label, not a provider model. */
  model?: string;
  /** What the engine reports to the readiness check. Default READY. */
  health?: DecisionEngineHealth;
  /** The answer for each question. Default: a probability of 0.5, which approves and rejects under no policy. */
  respond?: (spec: JevQuestionSpec) => FixtureAnswer;
  /** The calibration the answers report. The engines report uncalibrated today, so the default is uncalibrated. */
  calibrationStatus?: "calibrated" | "uncalibrated";
  /**
   * The token usage each request reports, as the OpenAI engine reports it. Absent, the engine reports no usage, as the JEV engine does.
   * A test that sets it sees the spend the decision records, so the usage is a fixture value, not a price.
   */
  usage?: DecisionUsage;
};

export class FixtureDecisionEngine implements DecisionEngine {
  readonly id: DecisionEngineId;
  readonly adapterVersion = "fixture-engine.v1";
  /** Every request this engine was asked, in order. A test reads it to show what was sent and how often. */
  readonly requests: DecisionRequest[] = [];
  private readonly options: FixtureEngineOptions;

  constructor(options: FixtureEngineOptions = {}) {
    this.id = options.id ?? "jev";
    this.options = options;
  }

  private modelName(): string {
    return this.options.model ?? "fixture-engine-model";
  }

  capabilities(): DecisionCapabilities {
    return {
      engineId: this.id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: ["text"],
      maxImages: 0,
      maxImageBytes: 0,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: this.options.usage !== undefined,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    };
  }

  async health(): Promise<DecisionEngineHealth> {
    return this.options.health ?? { status: "READY", message: "Fixture engine is ready." };
  }

  async healthFor(): Promise<DecisionEngineHealth> {
    return this.health();
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    const model = this.modelName();
    const calibrationStatus = this.options.calibrationStatus ?? "uncalibrated";
    const respond = this.options.respond ?? (() => ({ probability: 0.5 }));
    const evaluatedAt = new Date().toISOString();
    const answers: Record<string, JevAnswer> = {};
    for (const [key, spec] of Object.entries(request.questions)) {
      const base = {
        questionId: spec.id,
        questionVersion: spec.version,
        type: spec.type,
        model,
        provider: this.id,
        evidenceRefs: [],
        evaluatedAt,
      };
      const response = respond(spec);
      if (response === "abstain") {
        answers[key] = { ...base, status: "abstain_uncertain", abstainReason: "The fixture engine abstained." };
      } else if ("probability" in response) {
        answers[key] = {
          ...base,
          status: "answered",
          answer: response.probability,
          probability: response.probability,
          confidence: 0.9,
          semantics: "probability",
          calibrationStatus,
        };
      } else {
        answers[key] = {
          ...base,
          status: "answered",
          answer: response.choice,
          choice: response.choice,
          confidence: response.confidence ?? 0.9,
          semantics: "categorical",
        };
      }
    }
    return {
      runId: globalThis.crypto.randomUUID(),
      model,
      provider: this.id,
      inputHash: "fixture",
      cached: false,
      latencyMs: 0,
      answers,
      engineId: this.id,
      adapterVersion: this.adapterVersion,
      requestedModel: model,
      returnedModel: model,
      inputModality: "text",
      imageCount: 0,
      imagesOmitted: request.images?.length ?? 0,
      ...(this.options.usage ? { usage: { ...this.options.usage } } : {}),
    };
  }
}
