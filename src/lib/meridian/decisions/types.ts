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

export const DECISION_ENGINE_IDS = ["jev", "openai-decisions", "openrouter-decisions"] as const;
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
  /**
   * The backend and model the gate resolved for this decision, once. The engines use these values and do not read the settings again,
   * so the image decision and the call are made from the same resolution. Absent when the caller has not resolved them.
   */
  resolved?: {
    jevBackend?: "typesafe_direct" | "openrouter";
    openrouterModel?: { model: string; source: "workspace" | "deployment" | "default" };
  };
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
  /**
   * The most this call could have cost before it was sent: the model's context length at its catalogued input price. Set only on a
   * call that was sent, and checked against the per-call limit. It is a ceiling, not an estimate of what was billed.
   */
  ceilingUsd?: number;
  /**
   * The cost the provider reported for this call, in USD, when it reports one. It is what the provider said, not Meridian's
   * price table, and it is absent when the provider reports nothing. Never estimated.
   */
  reportedCostUsd?: number;
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
  | "budget_refused"
  | "network";

/**
 * Readiness, in the vocabulary the rest of Settings uses. CONFIGURED means the credentials and settings are present but no live
 * connection test has passed for them, so it is not a READY: READY needs a recorded successful check. UNSUPPORTED means the
 * engine cannot do what Meridian needs with the configured settings (for example an unverified model), and nothing is sent.
 */
export type DecisionEngineHealth =
  | { status: "READY"; message?: string }
  | { status: "CONFIGURED"; message: string }
  | { status: "NOT_CONFIGURED"; message: string }
  | { status: "UNSUPPORTED"; message: string }
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
  /** The provider the engine's model is served by, as the provider reported it (for example the model's author). */
  upstreamProvider?: string;
  /** The provider's own request id for this call, kept for support and audit. */
  providerRequestId?: string;
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
