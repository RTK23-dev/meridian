/**
 * Provider-neutral decision domain.
 *
 * Meridian owns its decision semantics: the question registry defines what is decided, the evidence layer defines what
 * is available, a decision engine evaluates the question, and the policy engine decides what the result means. A
 * decision engine (TypeSafe JEV, the OpenAI Decisions API) is an implementation detail behind `DecisionEngine`.
 *
 * Questions keep the registry's existing shape (`JevQuestionSpec`), whose three primitives map onto every supported
 * engine: `noul` is a predicate (probability that a condition is true), `choice` selects one predefined value, and
 * `score` evaluates against ordered levels. Provider-specific request and response types stay inside the adapters.
 */
import type {
  EvidenceRef,
  JevAnswer,
  JevDecisionRequest,
  JevDecisionResponse,
  JevQuestionType,
} from "../jev/types.ts";

export const DECISION_ENGINE_IDS = ["jev", "openai-decisions"] as const;
export type DecisionEngineId = (typeof DECISION_ENGINE_IDS)[number];

export function isDecisionEngineId(value: unknown): value is DecisionEngineId {
  return typeof value === "string" && (DECISION_ENGINE_IDS as readonly string[]).includes(value);
}

/** Neutral names for the question primitives. `noul` is the registry's historical name for a predicate. */
export type DecisionQuestionKind = "predicate" | "choice" | "score";

export function questionKindOf(type: JevQuestionType): DecisionQuestionKind {
  if (type === "noul") return "predicate";
  return type;
}

export type DecisionImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * An image supplied to a decision. The bytes are read from Meridian's storage by the caller, which has already checked
 * the caller's tenancy. Adapters never receive a storage id or a private URL they would have to resolve themselves.
 */
export type DecisionImageInput = {
  bytes: Uint8Array;
  /** Where the image came from, so a judgment can be traced to the frame or artifact it saw. */
  evidenceRef?: EvidenceRef;
  /** Short caption placed before the image, e.g. "Frame at 3.2s". Not sent when absent. */
  label?: string;
};

/**
 * A decision request. It extends the registry request with optional images.
 *
 * `imagePolicy` says what happens when the active engine cannot take images: "required" refuses the decision as
 * unsupported; "optional" decides on the text evidence alone and records that the images were not seen.
 */
export type DecisionRequest = JevDecisionRequest & {
  images?: DecisionImageInput[];
  imagePolicy?: "required" | "optional";
  /** Transport routing chosen by the caller, used by the JEV engine. Other engines ignore it. */
};

export type DecisionInputModality = "text" | "text+image";

export type DecisionCapabilities = {
  engineId: DecisionEngineId;
  questionKinds: DecisionQuestionKind[];
  inputModalities: Array<"text" | "image">;
  /** Images accepted in one request. 0 when the engine takes no images. */
  maxImages: number;
  /** Meridian's per-image limit for this engine, applied before any request is sent. */
  maxImageBytes: number;
  imageMimeTypes: DecisionImageMimeType[];
  /** Whether several questions can be answered in one request. */
  batchQuestions: boolean;
  /** Whether the engine reports token usage. */
  reportsUsage: boolean;
  /** What a returned number means for each kind. None of these is a calibrated Meridian probability. */
  semantics: {
    predicate: "probability";
    choice: "categorical_with_confidence";
    score: "ordered_level_expectation";
  };
};

export type DecisionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

/** Why a whole request failed. Per-question states live on each answer. */
export type DecisionFailureKind =
  | "not_configured"
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "unknown_model"
  | "invalid_request"
  | "provider_unavailable"
  | "invalid_response"
  | "unsupported_input"
  | "network";

export type DecisionEngineHealth =
  | { status: "READY"; message?: string }
  | { status: "NOT_CONFIGURED"; message: string }
  | { status: "DEGRADED" | "UNAVAILABLE"; message: string };

/**
 * A normalized decision result. It keeps the registry response shape, so existing consumers read answers unchanged,
 * and adds what is needed to audit and reproduce the decision.
 */
export type DecisionResult = JevDecisionResponse & {
  engineId: DecisionEngineId;
  adapterVersion: string;
  requestedModel: string;
  /** The model the provider reported. Equal to the requested model when the provider does not report one. */
  returnedModel: string;
  inputModality: DecisionInputModality;
  imageCount: number;
  /** Images supplied but not sent because the engine cannot take them (imagePolicy "optional"). */
  imagesOmitted: number;
  usage?: DecisionUsage;
  failure?: { kind: DecisionFailureKind; message: string };
};

export interface DecisionEngine {
  readonly id: DecisionEngineId;
  readonly adapterVersion: string;
  capabilities(): DecisionCapabilities;
  health(): Promise<DecisionEngineHealth>;
  /**
   * Readiness for one workspace, for engines whose credentials are saved per workspace. Callers that know the workspace
   * use this instead of `health()`, which has no workspace to check and never reports READY for one.
   */
  healthFor?(organizationId: string): Promise<DecisionEngineHealth>;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/** Builds the same abstained answer for every question in a request. */
export function abstainAll(
  request: JevDecisionRequest,
  input: {
    status: Exclude<JevAnswer["status"], "answered">;
    reason: string;
    model: string;
    provider: string;
  },
): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {};
  const evaluatedAt = new Date().toISOString();
  for (const [key, question] of Object.entries(request.questions)) {
    answers[key] = {
      questionId: question.id,
      questionVersion: question.version,
      type: question.type,
      model: input.model,
      provider: input.provider,
      status: input.status,
      evidenceRefs: [],
      abstainReason: input.reason,
      evaluatedAt,
    };
  }
  return answers;
}
