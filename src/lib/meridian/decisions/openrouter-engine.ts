/**
 * OpenRouter Decisions: the decision engine that calls OpenRouter's Decisions API with the workspace's OpenRouter key.
 *
 * The request is the Decisions request (`model`, `state`, `questions`), posted to the Decisions endpoint. It is not a chat
 * completion: nothing asks a chat model to write JSON, and every answer is read from the typed `answers` object the API returns,
 * keyed by the question name Meridian sent. A question whose primitive the selected model does not verify is refused before any
 * request is sent. Each decision makes one call. Nothing is retried, and no other engine, model or provider is tried when a call
 * fails: a failure is reported as the failure it is.
 *
 * The model is pinned. Only the verified decision models below are accepted, and an alias that moves to a new snapshot (a `~`
 * model id) is refused, so a decision model never changes under a workspace without a deliberate change here.
 */
import { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, checkImageBytes } from "../media/image-input.ts";
import { loadDefaultSql, secretForCategory } from "../credentials/resolve.ts";
import { UNCERTAIN_OUTCOME_NOTE } from "../providers/generation-ledger.ts";
import { ledgerDecisionHolds, type DecisionHolds } from "./holds.ts";
import { checkEvidenceSufficiency } from "../jev/client.ts";
import type { EvidenceRef, JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { decisionContextText } from "./openai-engine.ts";
import {
  readLatestOpenRouterCheck,
  readOpenRouterModel,
  type OpenRouterCheckRecord,
} from "./openrouter-settings.ts";
import {
  abstainAll,
  type DecisionCapabilities,
  type DecisionEngine,
  type DecisionEngineHealth,
  type DecisionFailureKind,
  type DecisionImageMimeType,
  type DecisionQuestionKind,
  type DecisionRequest,
  type DecisionResult,
  type DecisionUsage,
} from "./types.ts";
import {
  DecisionCatalogSource,
  DECISION_MODEL_PROFILES,
  decisionCallCapUsd,
  decisionCallCeilingUsd,
  liveDecisionCatalog,
} from "./decision-catalog.ts";
import { openRouterDecisionsModelSetting } from "../config/server-settings.ts";

export const OPENROUTER_DECISIONS_ADAPTER_VERSION = "openrouter-decisions-adapter.v1";
export const OPENROUTER_DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_DECISIONS_MODEL_ENV = "OPENROUTER_DECISIONS_MODEL";
export const OPENROUTER_DECISIONS_EXAMPLE_MODEL = "typesafe/jev-1.14";
export const OPENROUTER_DECISIONS_TIMEOUT_MS = 60_000;
/** Meridian's own cap on images in one decision. The provider documents no count limit, so this is a local bound, not a fact about the API. */
export const OPENROUTER_DECISIONS_MAX_IMAGES = 8;
export const OPENROUTER_DECISIONS_MAX_LEVELS = 10;
const MAX_MODEL_ID_LENGTH = 128;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;
const QUESTION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SUM_TOLERANCE = 0.02;
const EXPECTATION_TOLERANCE = 0.05;
const PROVIDER = "openrouter";
const IMAGE_MIME_TYPES: DecisionImageMimeType[] = ["image/png", "image/jpeg"];

/** The fixed sentence and question of the explicit connection test. Nothing from a workspace is sent with it. */
const CONNECTION_TEST_TEXT = "Meridian connection test. This sentence is the whole of the evidence. Answer the question from it.";
const CONNECTION_TEST_QUESTION: JevQuestionSpec = {
  id: "meridian.connection_test.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the evidence a connection test?",
  criteria: { true: "The evidence says it is a connection test.", false: "The evidence says it is anything else." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
};

/** What a connection test found. `not_run` means no request was sent, because the key or the model was missing or unverified. */
export type OpenRouterConnectionOutcome =
  | { kind: "not_run"; message: string }
  | {
      kind: "checked";
      status: "passed" | "failed";
      model: string;
      keyFingerprint: string;
      message: string;
      returnedModel: string;
      upstreamProvider: string | null;
      providerRequestId: string | null;
    };

/**
 * The decision models Meridian has verified, derived from the profile table in decision-catalog.ts. Anything not listed here is refused.
 * The catalogue decides which models exist; a profile decides what Meridian may ask them.
 */
export const VERIFIED_DECISION_MODELS: Record<string, { questionKinds: DecisionQuestionKind[]; images: boolean; note: string }> =
  Object.fromEntries(
    Object.entries(DECISION_MODEL_PROFILES).map(([model, profile]) => [
      model,
      { questionKinds: profile.questionKinds, images: profile.inputModalities.includes("image"), note: profile.source },
    ]),
  );

export type OpenRouterModelResolution =
  | { ok: true; model: string; source: "workspace" | "deployment" }
  | { ok: false; model: string; source: "workspace" | "deployment" | "none"; reason: string };

/** What a workspace is told when no decision model is chosen and the deployment sets none. Nothing is sent until one is chosen. */
export const NO_DECISION_MODEL_REASON =
  "No OpenRouter decision model is chosen for this workspace, and OPENROUTER_DECISIONS_MODEL is not set. Choose a model in Settings, then test the connection. Nothing was sent.";

/** Checks a model id is a pinned, verified decision model. The reason says what is wrong, and it never includes a key. */
export function validateDecisionModel(raw: string): { ok: true; model: string } | { ok: false; reason: string } {
  const model = raw.trim();
  if (!model) return { ok: false, reason: "The OpenRouter decision model ID is empty." };
  if (model.length > MAX_MODEL_ID_LENGTH) return { ok: false, reason: `The decision model ID is longer than ${MAX_MODEL_ID_LENGTH} characters.` };
  if (!MODEL_ID_PATTERN.test(model)) {
    return {
      ok: false,
      reason: `'${model}' is not a model ID. Use a provider and model, for example ${OPENROUTER_DECISIONS_EXAMPLE_MODEL}. Aliases with '~' are refused because they move to new snapshots.`,
    };
  }
  if (!VERIFIED_DECISION_MODELS[model]) {
    return {
      ok: false,
      reason: `Meridian has not verified '${model}' for decisions. The verified pinned models are ${Object.keys(VERIFIED_DECISION_MODELS).join(", ")}.`,
    };
  }
  return { ok: true, model };
}

/**
 * The model a workspace's decisions use: its own choice, then the deployment's. A blank deployment setting and no workspace choice is
 * refused: Meridian names no model of its own, so decisions never run on a model nobody chose. An invalid choice is reported, never
 * replaced.
 */
export function resolveOpenRouterDecisionModel(input: { workspace: string | null; deployment: string | undefined }): OpenRouterModelResolution {
  if (input.workspace !== null) {
    const checked = validateDecisionModel(input.workspace);
    return checked.ok
      ? { ok: true, model: checked.model, source: "workspace" }
      : { ok: false, model: input.workspace, source: "workspace", reason: checked.reason };
  }
  const deployment = input.deployment?.trim() ?? "";
  if (deployment) {
    const checked = validateDecisionModel(deployment);
    return checked.ok
      ? { ok: true, model: checked.model, source: "deployment" }
      : { ok: false, model: deployment, source: "deployment", reason: `${OPENROUTER_DECISIONS_MODEL_ENV} is not usable: ${checked.reason}` };
  }
  return { ok: false, model: "", source: "none", reason: NO_DECISION_MODEL_REASON };
}

/** The question kinds and image support one model is verified for. An unverified model supports nothing, so every question is refused. */
export function capabilitiesOfModel(model: string): { questionKinds: DecisionQuestionKind[]; images: boolean } {
  const verified = VERIFIED_DECISION_MODELS[model];
  return verified ? { questionKinds: verified.questionKinds, images: verified.images } : { questionKinds: [], images: false };
}

type WireQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

type ScoreLevels = { labels: string[]; descriptions: string[] };

/** The ordered level labels and descriptions of a score question. A level's label is the text before its first colon, or its position. */
function scoreLevelsOf(spec: JevQuestionSpec): ScoreLevels | { unsupported: string } {
  let entries: string[] = [];
  if (Array.isArray(spec.criteria)) {
    entries = spec.criteria;
  } else if (spec.levels && Object.keys(spec.levels).length > 0) {
    entries = Object.entries(spec.levels).map(([label, description]) => `${label}: ${description}`);
  }
  if (entries.length < 2) return { unsupported: "A score question needs at least two ordered levels." };
  if (entries.length > OPENROUTER_DECISIONS_MAX_LEVELS) {
    return { unsupported: `A score question can have at most ${OPENROUTER_DECISIONS_MAX_LEVELS} levels; this one has ${entries.length}.` };
  }
  const labels: string[] = [];
  const descriptions: string[] = [];
  entries.forEach((entry, index) => {
    const match = /^\s*([^:]{1,24}):\s*(.+)$/s.exec(entry);
    labels.push(match ? match[1].trim() : String(index + 1));
    descriptions.push(match ? match[2].trim() : entry.trim());
  });
  return { labels, descriptions };
}

/** The Decisions question for one of Meridian's questions. Noul carries its criteria in the instructions, because the API takes none for it. */
export function toOpenRouterQuestion(spec: JevQuestionSpec): WireQuestion | { unsupported: string } {
  if (spec.type === "noul") {
    const criteria = spec.criteria as { true?: string; false?: string };
    const lines = [spec.instructions];
    if (criteria?.true) lines.push(`True when: ${criteria.true}`);
    if (criteria?.false) lines.push(`False when: ${criteria.false}`);
    return { type: "noul", instructions: lines.join("\n") };
  }
  if (spec.type === "choice") {
    let choices: Record<string, string> = {};
    if (spec.criteria && !Array.isArray(spec.criteria) && typeof spec.criteria === "object") {
      choices = Object.fromEntries(Object.entries(spec.criteria as Record<string, string>));
    } else if (spec.options?.length) {
      choices = Object.fromEntries(spec.options.map((value) => [value, value]));
    }
    if (Object.keys(choices).length < 2) return { unsupported: "A choice question needs at least two defined values." };
    return { type: "choice", instructions: spec.instructions, criteria: choices };
  }
  if (spec.type === "score") {
    const levels = scoreLevelsOf(spec);
    if ("unsupported" in levels) return levels;
    return { type: "score", instructions: spec.instructions, criteria: levels.descriptions };
  }
  return { unsupported: `Question type '${String((spec as { type: unknown }).type)}' is not a Decisions question type.` };
}

function probabilityOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function nonNegativeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A probability map over known names that sums to one. `undefined` when absent, `"invalid"` when present and not a valid distribution. */
function distributionOf(raw: unknown, names: string[]): Record<string, number> | "invalid" | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!names.includes(name)) return "invalid";
    const probability = probabilityOf(value);
    if (probability === undefined) return "invalid";
    out[name] = probability;
  }
  const total = Object.values(out).reduce((sum, value) => sum + value, 0);
  if (Object.keys(out).length === 0 || Math.abs(total - 1) > SUM_TOLERANCE) return "invalid";
  return out;
}

/** Normalizes one provider answer. Anything missing, of the wrong type, out of range or contradictory is an invalid answer, never a verdict. */
export function normalizeOpenRouterAnswer(input: {
  spec: JevQuestionSpec;
  wire: WireQuestion;
  raw: unknown;
  model: string;
  levelLabels?: string[];
}): JevAnswer {
  const base = {
    questionId: input.spec.id,
    questionVersion: input.spec.version,
    type: input.spec.type,
    model: input.model,
    provider: PROVIDER,
    evidenceRefs: [] as EvidenceRef[],
    evaluatedAt: new Date().toISOString(),
  };
  const invalid = (reason: string): JevAnswer => ({ ...base, status: "invalid_response", abstainReason: reason });
  const raw = input.raw as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return invalid("The provider returned no answer for this question.");
  if (raw.type !== input.wire.type) return invalid(`Expected a ${input.wire.type} answer; received '${String(raw.type)}'.`);

  if (input.wire.type === "noul") {
    const probability = probabilityOf(raw.noul);
    if (probability === undefined) return invalid("The noul answer has no probability between 0 and 1.");
    return {
      ...base,
      status: "answered",
      noul: probability,
      probability,
      answer: probability,
      semantics: "probability",
      calibrationStatus: "uncalibrated",
    };
  }

  const confidence = raw.confidence === undefined ? undefined : probabilityOf(raw.confidence);
  if (raw.confidence !== undefined && confidence === undefined) return invalid("The confidence is not a number between 0 and 1.");

  if (input.wire.type === "choice") {
    const allowed = Object.keys(input.wire.criteria);
    const choice = raw.choice;
    if (typeof choice !== "string" || !allowed.includes(choice)) {
      return invalid(`The choice answer '${String(choice)}' is not one of the defined values.`);
    }
    const probabilities = distributionOf(raw.probabilities, allowed);
    if (probabilities === "invalid") return invalid("The choice probabilities are not a valid distribution over the defined values.");
    if (probabilities) {
      const top = Math.max(...Object.values(probabilities));
      if ((probabilities[choice] ?? 0) < top - 1e-9) return invalid("The chosen value does not have the highest probability; the answer contradicts itself.");
    }
    return {
      ...base,
      status: "answered",
      choice,
      answer: choice,
      probabilities,
      confidence,
      semantics: "categorical",
      calibrationStatus: "uncalibrated",
    };
  }

  const labels = input.levelLabels ?? [];
  const score = raw.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > labels.length - 1) {
    return invalid(`The score answer is not a position within the ${labels.length} defined levels.`);
  }
  const indexes = labels.map((_, index) => String(index));
  const byIndex = distributionOf(raw.probabilities, indexes);
  if (byIndex === "invalid") return invalid("The score probabilities are not a valid distribution over the defined levels.");
  let probabilities: Record<string, number> | undefined;
  if (byIndex) {
    const expectation = Object.entries(byIndex).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0);
    if (Math.abs(expectation - score) > EXPECTATION_TOLERANCE) {
      return invalid("The score is not the probability-weighted average of its levels; the answer contradicts itself.");
    }
    probabilities = Object.fromEntries(Object.entries(byIndex).map(([index, probability]) => [labels[Number(index)], probability]));
  }
  return {
    ...base,
    status: "answered",
    score,
    answer: score,
    probabilities,
    confidence,
    legend: Object.fromEntries(labels.map((label, index) => [String(index), label])),
    semantics: "ordered_score",
    calibrationStatus: "uncalibrated",
  };
}

/** The usage the provider reported, with the ceiling Meridian checked before the call. Both are kept so they can be reconciled. */
function withCeiling(usage: DecisionUsage | undefined, ceilingUsd: number): DecisionUsage {
  return { ...(usage ?? {}), ceilingUsd };
}

/** A model the gate already resolved for this decision, checked again here so a stored value cannot widen what is sent. */
function resolvedModelOf(resolved: { model: string; source: "workspace" | "deployment" | "none" }): OpenRouterModelResolution {
  if (resolved.source === "none") return { ok: false, model: "", source: "none", reason: NO_DECISION_MODEL_REASON };
  const checked = validateDecisionModel(resolved.model);
  if (!checked.ok) return { ok: false, model: resolved.model, source: resolved.source, reason: checked.reason };
  return { ok: true, model: checked.model, source: resolved.source };
}

function usageOf(decoded: Record<string, unknown>): DecisionUsage | undefined {
  const usage = decoded.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const fields = usage as Record<string, unknown>;
  const input = nonNegativeOf(fields.input_tokens);
  const output = nonNegativeOf(fields.output_tokens);
  const cost = nonNegativeOf(fields.cost);
  if (input === undefined && output === undefined && cost === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {}),
    ...(cost !== undefined ? { reportedCostUsd: cost } : {}),
  };
}

/** Removes anything key-shaped from a provider's error text, and shortens it, before it is shown or stored. */
export function safeProviderText(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** The failure a non-2xx status means. Only a 429 is a rate limit; a 5xx is the provider being unavailable, which is never retried here. */
export function failureKindForStatus(status: number, body: string): DecisionFailureKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status === 404) return "unknown_model";
  if (status === 400 || status === 422) return /\bmodel\b/i.test(body) ? "unknown_model" : "invalid_request";
  if (status === 402) return "provider_unavailable";
  if (status >= 500) return "provider_unavailable";
  return "invalid_request";
}

export type OpenRouterKey = { secret: string | null; fingerprint: string; reason: string };

/** Where the key for one workspace comes from. The default reads the workspace's saved OpenRouter key, then the deployment key only when shared. */
export interface OpenRouterKeySource {
  keyFor(organizationId: string | undefined): Promise<OpenRouterKey>;
}

export interface OpenRouterCheckStore {
  workspaceModel(organizationId: string): Promise<string | null>;
  latestCheck(organizationId: string): Promise<OpenRouterCheckRecord | null>;
}

const databaseKeys: OpenRouterKeySource = {
  async keyFor(organizationId) {
    const resolved = await secretForCategory("openrouter", organizationId);
    return { secret: resolved.secret, fingerprint: resolved.fingerprint ?? "", reason: resolved.reason };
  },
};

const databaseStore: OpenRouterCheckStore = {
  async workspaceModel(organizationId) {
    return readOpenRouterModel(await loadDefaultSql(), organizationId);
  },
  async latestCheck(organizationId) {
    return readLatestOpenRouterCheck(await loadDefaultSql(), organizationId);
  },
};

export class OpenRouterDecisionsEngine implements DecisionEngine {
  readonly id = "openrouter-decisions" as const;
  readonly adapterVersion = OPENROUTER_DECISIONS_ADAPTER_VERSION;
  private readonly fetchImpl: typeof fetch;
  private readonly holds: DecisionHolds;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly keys: OpenRouterKeySource;
  private readonly store: OpenRouterCheckStore;
  private readonly deploymentModel: string | undefined;

  constructor(options: {
    fetchImpl?: typeof fetch;
    endpoint?: string;
    timeoutMs?: number;
    keys?: OpenRouterKeySource;
    store?: OpenRouterCheckStore;
    /** The deployment's OPENROUTER_DECISIONS_MODEL. Read from the environment when not given. */
    deploymentModel?: string;
    /** The live model catalogue. A decision is refused unless its model is in it. */
    catalog?: DecisionCatalogSource;
    /** The budget hold each call is written to. The workspace's ledger unless a test gives its own. */
    holds?: DecisionHolds;
  } = {}) {
    this.catalog = options.catalog ?? liveDecisionCatalog;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.holds = options.holds ?? ledgerDecisionHolds();
    this.endpoint = options.endpoint ?? OPENROUTER_DECISIONS_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? OPENROUTER_DECISIONS_TIMEOUT_MS;
    this.keys = options.keys ?? databaseKeys;
    this.store = options.store ?? databaseStore;
    this.deploymentModel = options.deploymentModel ?? openRouterDecisionsModelSetting();
  }

  private readonly catalog: DecisionCatalogSource;

  /** The capabilities across every verified model, since the model is chosen per workspace. Per decision, the model's own limits apply. */
  capabilities(): DecisionCapabilities {
    return {
      engineId: this.id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: ["text", "image"],
      maxImages: OPENROUTER_DECISIONS_MAX_IMAGES,
      maxImageBytes: MAX_IMAGE_BYTES,
      imageMimeTypes: [...IMAGE_MIME_TYPES],
      batchQuestions: true,
      reportsUsage: true,
      semantics: {
        predicate: "probability",
        choice: "categorical_with_confidence",
        score: "ordered_level_expectation",
      },
    };
  }

  private async modelFor(organizationId: string | undefined): Promise<OpenRouterModelResolution> {
    const workspace = organizationId ? await this.store.workspaceModel(organizationId) : null;
    return resolveOpenRouterDecisionModel({ workspace, deployment: this.deploymentModel });
  }

  /** Readiness for one workspace. READY needs a passed connection check for this model and this key; nothing here calls the provider. */
  async healthFor(organizationId: string): Promise<DecisionEngineHealth> {
    let key: OpenRouterKey;
    let model: OpenRouterModelResolution;
    let check: OpenRouterCheckRecord | null;
    try {
      key = await this.keys.keyFor(organizationId);
      model = await this.modelFor(organizationId);
      check = await this.store.latestCheck(organizationId);
    } catch {
      return { status: "UNAVAILABLE", message: "The OpenRouter Decisions settings could not be read, so the engine cannot be checked." };
    }
    if (!key.secret) return { status: "NOT_CONFIGURED", message: key.reason || "No OpenRouter key is saved for this workspace." };
    if (!model.ok) return { status: "UNSUPPORTED", message: model.reason };
    const sameKeyAndModel = check !== null && check.model === model.model && check.keyFingerprint === key.fingerprint;
    if (sameKeyAndModel && check?.status === "passed") {
      return { status: "READY", message: `The connection test passed on ${check.checkedAt} for ${model.model}.` };
    }
    if (sameKeyAndModel && check?.status === "failed") {
      return { status: "CONFIGURED", message: `The last connection test failed: ${check.message}. Test the connection again before choosing this engine.` };
    }
    return {
      status: "CONFIGURED",
      message: `The key and model ${model.model} are set. No connection test has passed for them yet, so this is not ready.`,
    };
  }

  async health(): Promise<DecisionEngineHealth> {
    return { status: "NOT_CONFIGURED", message: "OpenRouter Decisions readiness is reported per workspace." };
  }

  /**
   * An explicit connection test: one real Decisions request with a fixed sentence and one yes/no question. It may incur model usage.
   * It reads the workspace's key and model, sends nothing when either is missing or unverified, and returns the outcome. It changes
   * no product data, no active engine and no setting: the caller records the outcome.
   */
  async connectionCheck(organizationId: string): Promise<OpenRouterConnectionOutcome> {
    const key = await this.keys.keyFor(organizationId);
    const model = await this.modelFor(organizationId);
    if (!key.secret) return { kind: "not_run", message: key.reason || "No OpenRouter key is saved for this workspace, so no test was sent." };
    if (!model.ok) return { kind: "not_run", message: model.reason };
    const result = await this.decide({
      organizationId,
      brandId: "",
      state: { description: CONNECTION_TEST_TEXT },
      questions: { connection_test: CONNECTION_TEST_QUESTION },
      imagePolicy: "required",
    });
    const answer = result.answers.connection_test;
    const passed = !result.failure && answer?.status === "answered";
    const reason = result.failure?.message ?? (answer?.status === "answered" ? "" : answer?.abstainReason ?? "The test returned no usable answer.");
    return {
      kind: "checked",
      status: passed ? "passed" : "failed",
      model: model.model,
      keyFingerprint: key.fingerprint,
      message: passed ? `The provider answered for ${result.returnedModel}.` : safeProviderText(reason),
      returnedModel: result.returnedModel,
      upstreamProvider: result.upstreamProvider ?? null,
      providerRequestId: result.providerRequestId ?? null,
    };
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = Date.now();
    const runId = globalThis.crypto.randomUUID();
    const key = await this.keys.keyFor(request.organizationId);
    const model = request.resolved?.openrouterModel
      ? resolvedModelOf(request.resolved.openrouterModel)
      : await this.modelFor(request.organizationId);
    const requestedModel = model.model;
    const imageCount = request.images?.length ?? 0;
    const imagePolicy = request.imagePolicy ?? "required";
    const finish = (fields: Partial<DecisionResult> & Pick<DecisionResult, "answers">): DecisionResult => ({
      runId,
      model: fields.returnedModel ?? requestedModel,
      provider: PROVIDER,
      inputHash: fields.inputHash ?? "not_sent",
      cached: false,
      latencyMs: Date.now() - started,
      engineId: this.id,
      adapterVersion: this.adapterVersion,
      requestedModel,
      returnedModel: fields.returnedModel ?? requestedModel,
      inputModality: "text",
      imageCount,
      imagesOmitted: 0,
      ...fields,
    });

    if (!key.secret) {
      const message = key.reason || "No OpenRouter key is saved for this workspace.";
      return finish({ answers: abstainAll(request, { status: "not_configured", reason: message, model: requestedModel, provider: PROVIDER }), failure: { kind: "not_configured", message } });
    }
    if (!model.ok) {
      return finish({ answers: abstainAll(request, { status: "unsupported", reason: model.reason, model: requestedModel, provider: PROVIDER }), failure: { kind: "unknown_model", message: model.reason } });
    }
    // The live catalogue decides whether the model exists for this endpoint, and its price bounds the call before it is sent.
    const catalog = await this.catalog.read();
    if (!catalog.ok) {
      return finish({ answers: abstainAll(request, { status: "provider_error", reason: catalog.reason, model: requestedModel, provider: PROVIDER }), failure: { kind: "provider_unavailable", message: catalog.reason } });
    }
    const listed = catalog.entries.find((entry) => entry.id === model.model);
    if (!listed) {
      const message = `${model.model} is not in the live catalogue of decision models, so nothing was sent.`;
      return finish({ answers: abstainAll(request, { status: "unsupported", reason: message, model: requestedModel, provider: PROVIDER }), failure: { kind: "unknown_model", message } });
    }
    const cap = decisionCallCapUsd();
    if (!cap.ok) {
      return finish({ answers: abstainAll(request, { status: "unsupported", reason: cap.reason, model: requestedModel, provider: PROVIDER }), failure: { kind: "invalid_request", message: cap.reason } });
    }
    const verified = capabilitiesOfModel(model.model);

    // Images: each is checked by its own bytes and must be PNG or JPEG. A required image the model cannot take refuses the decision;
    // an optional one is left out, and the omission is recorded rather than hidden.
    const usable: Array<{ dataUrl: string; label?: string }> = [];
    let omitted = 0;
    let imageProblem: string | null = null;
    let total = 0;
    for (const [index, image] of (request.images ?? []).entries()) {
      const checked = checkImageBytes(image.bytes, `Image ${index + 1}`);
      let problem: string | null = null;
      let mimeType = "";
      if (!checked.ok) {
        problem = checked.reason;
      } else {
        mimeType = checked.mimeType;
        if (!IMAGE_MIME_TYPES.includes(checked.mimeType as DecisionImageMimeType)) {
          problem = `OpenRouter Decisions takes PNG and JPEG images; image ${index + 1} is ${checked.mimeType}.`;
        } else if (!verified.images) {
          problem = `${model.model} takes no images.`;
        } else if (usable.length >= OPENROUTER_DECISIONS_MAX_IMAGES) {
          problem = `At most ${OPENROUTER_DECISIONS_MAX_IMAGES} images can be sent in one decision.`;
        }
      }
      if (problem !== null) {
        if (imagePolicy === "required") {
          imageProblem = problem;
          break;
        }
        omitted += 1;
        continue;
      }
      total += image.bytes.byteLength;
      if (total > MAX_TOTAL_IMAGE_BYTES) {
        imageProblem = `Images total more than ${MAX_TOTAL_IMAGE_BYTES} bytes.`;
        break;
      }
      usable.push({ dataUrl: `data:${mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`, label: image.label });
    }
    if (imageProblem) {
      return finish({
        answers: abstainAll(request, { status: "unsupported", reason: imageProblem, model: requestedModel, provider: PROVIDER }),
        failure: { kind: "unsupported_input", message: imageProblem },
        imagesOmitted: 0,
      });
    }

    const availableEvidence = [
      ...((((request.state as Record<string, unknown>).availableEvidence as string[] | undefined) ?? [])),
      ...((request.state.records ?? []).flatMap((record) => record.availableEvidence ?? [])),
    ];
    const answers: Record<string, JevAnswer> = {};
    const asked: Array<{ key: string; spec: JevQuestionSpec; wire: WireQuestion; levelLabels?: string[] }> = [];
    for (const [name, spec] of Object.entries(request.questions)) {
      const sufficiency = checkEvidenceSufficiency(spec, availableEvidence);
      if (!sufficiency.sufficient) {
        answers[name] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: requestedModel,
          provider: PROVIDER,
          status: "abstain_insufficient_evidence",
          evidenceRefs: [],
          abstainReason: `Missing required evidence: ${sufficiency.missing.join(", ")}`,
          evaluatedAt: new Date().toISOString(),
        };
        continue;
      }
      const kindOk = verified.questionKinds.includes(spec.type === "noul" ? "predicate" : spec.type);
      const wire = kindOk ? toOpenRouterQuestion(spec) : { unsupported: `${model.model} is not verified for '${spec.type}' questions.` };
      const nameOk = QUESTION_NAME_PATTERN.test(name);
      if ("unsupported" in wire || !nameOk) {
        answers[name] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: requestedModel,
          provider: PROVIDER,
          status: "unsupported",
          evidenceRefs: [],
          abstainReason: "unsupported" in wire ? wire.unsupported : "The question name is not usable as a Decisions question name.",
          evaluatedAt: new Date().toISOString(),
        };
        continue;
      }
      const levelLabels = spec.type === "score" ? scoreLevelsOf(spec) : undefined;
      asked.push({ key: name, spec, wire, levelLabels: levelLabels && !("unsupported" in levelLabels) ? levelLabels.labels : undefined });
    }
    if (asked.length === 0) return finish({ answers, imagesOmitted: omitted, inputModality: usable.length > 0 ? "text+image" : "text" });

    const text = decisionContextText(request);
    const state = usable.length === 0
      ? text
      : [text, ...usable.flatMap((image) => (image.label ? [image.label, { type: "image_url", image_url: { url: image.dataUrl } }] : [{ type: "image_url", image_url: { url: image.dataUrl } }]))];
    const questions = Object.fromEntries(asked.map((entry) => [entry.key, entry.wire]));
    const payload = JSON.stringify({ model: model.model, state, questions });
    // The most this request can cost is bounded from the request itself, before anything is sent. A bound above the deployment's
    // limit refuses the call, and the refusal says the numbers.
    const requestBytes = new TextEncoder().encode(payload).length;
    const ceilingUsd = decisionCallCeilingUsd(listed, { requestBytes, hasImages: usable.length > 0 });
    if (ceilingUsd > cap.usd) {
      const message = `The most this call can cost is $${ceilingUsd.toFixed(6)} (its ${requestBytes}-byte request at the input price, plus the model's largest output; a call with an image is bounded by the whole context), above the $${cap.usd} per-call limit, so nothing was sent.`;
      return finish({ answers: abstainAll(request, { status: "unsupported", reason: message, model: requestedModel, provider: PROVIDER }), failure: { kind: "budget_refused", message } });
    }
    const inputHash = await hashOf(`${model.model}\n${JSON.stringify(questions)}\n${text}\n${usable.map((image) => image.dataUrl).join("")}`);
    // The call is held before it is sent. A hold that cannot be written, or a month that cannot fit it, refuses the call with the reason.
    const hold = await this.holds.reserve(
      {
        organizationId: request.organizationId,
        brandId: request.brandId || null,
        correlationId: inputHash.slice(0, 32),
        operation: "jev.decision",
        promptId: "jev.decision",
        promptVersion: "1",
        inputRef: inputHash,
        provider: PROVIDER,
        model: model.model,
        modelSource: "workspace",
      },
      ceilingUsd,
    );
    if (hold.status === "refused") {
      return finish({ answers: abstainAll(request, { status: "unsupported", reason: hold.reason, model: requestedModel, provider: PROVIDER }), failure: { kind: "budget_refused", message: hold.reason } });
    }
    const holdId = hold.id;

    const fail = (kind: DecisionFailureKind, message: string): DecisionResult => {
      for (const entry of asked) {
        answers[entry.key] = {
          questionId: entry.spec.id,
          questionVersion: entry.spec.version,
          type: entry.spec.type,
          model: requestedModel,
          provider: PROVIDER,
          status: kind === "invalid_response" ? "invalid_response" : "provider_error",
          evidenceRefs: [],
          abstainReason: message,
          evaluatedAt: new Date().toISOString(),
        };
      }
      return finish({ answers, inputHash, inputModality: usable.length > 0 ? "text+image" : "text", imagesOmitted: omitted, failure: { kind, message } });
    };

    // One call. A timeout, a refusal or a server error is reported as it is, never retried: a retried paid call could be billed twice.
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` },
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const message = timedOut
        ? `OpenRouter Decisions did not respond within ${this.timeoutMs} ms.`
        : `OpenRouter Decisions could not be reached: ${error instanceof Error ? safeProviderText(error.message) : "unknown error"}.`;
      await this.holds.settle(holdId, { status: "uncertain", error: `${message} ${UNCERTAIN_OUTCOME_NOTE}`, latencyMs: Date.now() - started });
      return fail(timedOut ? "timeout" : "network", message);
    }
    if (!response.ok) {
      const body = safeProviderText(await response.text().catch(() => ""));
      const kind = failureKindForStatus(response.status, body);
      const message = `OpenRouter Decisions returned HTTP ${response.status}${body ? `: ${body}` : "."}`;
      // No error status releases a hold: OpenRouter documents the statuses but no billing rule for them.
      await this.holds.settle(holdId, { status: "uncertain", error: `${message} ${UNCERTAIN_OUTCOME_NOTE}`, latencyMs: Date.now() - started });
      return fail(kind, message);
    }

    let decoded: Record<string, unknown>;
    try {
      decoded = (await response.json()) as Record<string, unknown>;
    } catch {
      await this.holds.settle(holdId, { status: "uncertain", error: `OpenRouter Decisions returned a body that is not JSON. ${UNCERTAIN_OUTCOME_NOTE}`, latencyMs: Date.now() - started });
      return fail("invalid_response", "OpenRouter Decisions returned a body that is not JSON.");
    }
    const answersBody = decoded && typeof decoded === "object" ? (decoded as { answers?: unknown }).answers : undefined;
    if (!answersBody || typeof answersBody !== "object" || Array.isArray(answersBody)) {
      await this.holds.settle(holdId, { status: "uncertain", error: `OpenRouter Decisions returned no answers object. ${UNCERTAIN_OUTCOME_NOTE}`, latencyMs: Date.now() - started });
      return fail("invalid_response", "OpenRouter Decisions returned no answers object.");
    }
    const returnedModel = typeof decoded.model === "string" && decoded.model.trim() ? decoded.model.trim() : model.model;
    const byName = answersBody as Record<string, unknown>;
    for (const entry of asked) {
      answers[entry.key] = normalizeOpenRouterAnswer({
        spec: entry.spec,
        wire: entry.wire,
        raw: byName[entry.key],
        model: returnedModel,
        levelLabels: entry.levelLabels,
      });
    }
    const usage = usageOf(decoded);
    await this.holds.settle(holdId, {
      status: "completed",
      output: "",
      latencyMs: Date.now() - started,
      tokens: usage?.totalTokens ?? null,
      returnedModel,
      generationId: typeof decoded.id === "string" ? decoded.id : null,
      costUsd: usage?.reportedCostUsd ?? null,
      error: "",
    });
    return finish({
      answers,
      inputHash,
      inputModality: usable.length > 0 ? "text+image" : "text",
      imagesOmitted: omitted,
      returnedModel,
      usage: withCeiling(usageOf(decoded), ceilingUsd),
      upstreamProvider: typeof decoded.provider === "string" ? decoded.provider : undefined,
      providerRequestId: typeof decoded.id === "string" ? decoded.id : undefined,
    });
  }
}

async function hashOf(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
