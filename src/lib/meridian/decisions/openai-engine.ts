/**
 * OpenAI Decisions engine adapter.
 *
 * Calls the native Decisions endpoint (`POST /v1/decisions`, public beta). It is not a prompt-based approximation: each
 * registry question becomes a typed Decisions question (`predicate`, `choice`, or `score`) and each typed answer is
 * normalized into Meridian's answer model.
 *
 * Contract followed (developers.openai.com, Decisions guide and create reference, read 2026-10-10):
 * - Request: `model`, `input` (a string, or user messages of `input_text` and `input_image` parts), `questions`
 *   (each with a unique `name`, a `type`, and `instructions`; `choice` adds `choices: [{ value, description }]`,
 *   `score` adds `levels: [{ label, description }]` ordered lowest to highest), optional `safety_identifier`.
 * - Images: base64 data URLs. The guide says hosted URLs and file ids are not supported; the reference also lists
 *   public URLs. Meridian only sends data URLs, so private media is never made public. At most 128 images.
 * - Response: `answers` in question order. `predicate` has `probability`; `choice` has `choice`, `probabilities`
 *   (`value`, `probability`) and `confidence`; `score` has `score` (a probability-weighted level index), `probabilities`
 *   (`value`, `label`, `probability`) and `confidence`; a refusal has `type: "refusal"`. `model` and `usage` are
 *   returned.
 *
 * The official TypeScript SDK supports Decisions from openai@7.30.0. Meridian calls providers with fetch throughout,
 * so this adapter uses the REST contract directly instead of adding the SDK.
 *
 * Nothing here has been run against the live API in this repository. Its tests use fixtures shaped like the
 * documented contract.
 */
import { createHash } from "node:crypto";
import { ACCEPTED_IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, checkImageBytes } from "../media/image-input.ts";
import { secretForCategory } from "../credentials/resolve.ts";
import { checkEvidenceSufficiency, minimizeJevState } from "../jev/client.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import {
  abstainAll,
  type DecisionCapabilities,
  type DecisionEngine,
  type DecisionEngineHealth,
  type DecisionFailureKind,
  type DecisionImageMimeType,
  type DecisionRequest,
  type DecisionResult,
  type DecisionUsage,
} from "./types.ts";

export const OPENAI_DECISIONS_ADAPTER_VERSION = "openai-decisions-adapter.v1";
export const OPENAI_DECISIONS_DEFAULT_MODEL = "gpt-6-luna";
export const OPENAI_DECISIONS_MAX_IMAGES = 128;
/** Meridian's own per-image cap. The API documents no size limit; this keeps request bodies bounded. */
export const OPENAI_DECISIONS_MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
/** Meridian's cap on all image bytes in one request. */
export const OPENAI_DECISIONS_MAX_TOTAL_IMAGE_BYTES = MAX_TOTAL_IMAGE_BYTES;
const ACCEPTED_IMAGE_TYPES: DecisionImageMimeType[] = [...ACCEPTED_IMAGE_MIME_TYPES];
const PROVIDER = "openai";

export type OpenAiDecisionsConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Extra attempts after a rate limit or a 5xx. Bounded; 0 disables retries. */
  maxRetries: number;
};

export function resolveOpenAiDecisionsConfig(overrides: Partial<OpenAiDecisionsConfig> = {}): OpenAiDecisionsConfig {
  const env = process.env;
  const timeout = Number(env.OPENAI_DECISIONS_TIMEOUT_MS);
  const retries = Number(env.OPENAI_DECISIONS_MAX_RETRIES);
  return {
    // The key is never read from the environment here. A request resolves the workspace's key (see keyFor).
    apiKey: overrides.apiKey ?? "",
    baseUrl: (overrides.baseUrl ?? env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: overrides.model ?? env.OPENAI_DECISIONS_MODEL?.trim() ?? OPENAI_DECISIONS_DEFAULT_MODEL,
    timeoutMs: overrides.timeoutMs ?? (Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000),
    maxRetries: overrides.maxRetries ?? (Number.isInteger(retries) && retries >= 0 ? Math.min(retries, 3) : 1),
  };
}

type WireQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: Array<{ value: string; description: string }> }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description: string }> };

type WireInputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type WireInput = string | Array<{ type: "message"; role: "user"; content: WireInputPart[] }>;

/** The question in wire form, or why it cannot be represented. */
export function toWireQuestion(name: string, spec: JevQuestionSpec): WireQuestion | { unsupported: string } {
  if (spec.type === "noul") {
    const criteria = spec.criteria as { true?: string; false?: string };
    const lines = [spec.instructions];
    if (criteria?.true) lines.push(`True when: ${criteria.true}`);
    if (criteria?.false) lines.push(`False when: ${criteria.false}`);
    return { type: "predicate", name, instructions: lines.join("\n") };
  }
  if (spec.type === "choice") {
    const criteria = spec.criteria;
    let choices: Array<{ value: string; description: string }> = [];
    if (criteria && !Array.isArray(criteria) && typeof criteria === "object") {
      choices = Object.entries(criteria as Record<string, string>).map(([value, description]) => ({ value, description }));
    } else if (spec.options?.length) {
      choices = spec.options.map((value) => ({ value, description: value }));
    }
    if (choices.length < 2) return { unsupported: "A choice question needs at least two defined values." };
    return { type: "choice", name, instructions: spec.instructions, choices };
  }
  if (spec.type === "score") {
    let levels: Array<{ label: string; description: string }> = [];
    if (Array.isArray(spec.criteria)) {
      levels = spec.criteria.map((entry, index) => {
        const match = /^\s*([^:]{1,24}):\s*(.+)$/s.exec(entry);
        return match ? { label: match[1].trim(), description: match[2].trim() } : { label: String(index + 1), description: entry };
      });
    } else if (spec.levels && Object.keys(spec.levels).length > 0) {
      levels = Object.entries(spec.levels).map(([label, description]) => ({ label, description }));
    }
    if (levels.length < 2) return { unsupported: "A score question needs at least two ordered levels." };
    return { type: "score", name, instructions: spec.instructions, levels };
  }
  return { unsupported: `Question type '${String((spec as { type: unknown }).type)}' is not a Decisions question type.` };
}

/** The text context sent with every question: the minimized structured state, never secrets. */
export function decisionContextText(request: DecisionRequest): string {
  const state = minimizeJevState(request.state as Record<string, unknown>);
  const { description, ...rest } = state as { description?: unknown } & Record<string, unknown>;
  const parts: string[] = [];
  if (typeof description === "string" && description.trim()) parts.push(description.trim());
  if (Object.keys(rest).length > 0) parts.push(`Structured evidence (JSON):\n${JSON.stringify(rest)}`);
  return parts.join("\n\n") || "No textual evidence was supplied.";
}

type ValidatedImage = { dataUrl: string; label?: string };

/** Validates every image by its own bytes. Returns the reason the set is unusable, or the data URLs. */
export function prepareImages(
  images: DecisionRequest["images"],
): { ok: true; images: ValidatedImage[] } | { ok: false; reason: string } {
  const list = images ?? [];
  if (list.length > OPENAI_DECISIONS_MAX_IMAGES) {
    return { ok: false, reason: `At most ${OPENAI_DECISIONS_MAX_IMAGES} images can be sent in one decision; ${list.length} were supplied.` };
  }
  let total = 0;
  const prepared: ValidatedImage[] = [];
  for (const [index, image] of list.entries()) {
    const checked = checkImageBytes(image.bytes, `Image ${index + 1}`);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    total += image.bytes.byteLength;
    if (total > OPENAI_DECISIONS_MAX_TOTAL_IMAGE_BYTES) {
      return { ok: false, reason: `Images total more than ${OPENAI_DECISIONS_MAX_TOTAL_IMAGE_BYTES} bytes.` };
    }
    prepared.push({ dataUrl: `data:${checked.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`, label: image.label });
  }
  return { ok: true, images: prepared };
}

function buildInput(text: string, images: ValidatedImage[]): WireInput {
  if (images.length === 0) return text;
  const content: WireInputPart[] = [{ type: "input_text", text }];
  for (const image of images) {
    if (image.label) content.push({ type: "input_text", text: image.label });
    content.push({ type: "input_image", image_url: image.dataUrl });
  }
  return [{ type: "message", role: "user", content }];
}

function finiteProbability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function distribution(value: unknown, key: "value" | "label"): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as Record<string, unknown>)[key] ?? (entry as Record<string, unknown>).value;
    const probability = finiteProbability((entry as Record<string, unknown>).probability);
    if ((typeof name === "string" || typeof name === "number") && probability !== undefined) out[String(name)] = probability;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalizes one wire answer. Anything that is not a well-formed answer of the asked type is not an answer. */
export function normalizeAnswer(input: {
  key: string;
  spec: JevQuestionSpec;
  wire: WireQuestion;
  raw: unknown;
  model: string;
}): JevAnswer {
  const base = {
    questionId: input.spec.id,
    questionVersion: input.spec.version,
    type: input.spec.type,
    model: input.model,
    provider: PROVIDER,
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  };
  const abstain = (status: "refused" | "invalid_response", reason: string): JevAnswer => ({
    ...base,
    status,
    abstainReason: reason,
  });
  const raw = input.raw as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return abstain("invalid_response", "The provider returned no answer for this question.");
  if (raw.type === "refusal") return abstain("refused", "The provider refused to answer this question.");
  if (raw.type !== input.wire.type) {
    return abstain("invalid_response", `Expected a ${input.wire.type} answer; received '${String(raw.type)}'.`);
  }

  if (input.wire.type === "predicate") {
    const probability = finiteProbability(raw.probability);
    if (probability === undefined) return abstain("invalid_response", "The predicate answer has no probability between 0 and 1.");
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

  if (input.wire.type === "choice") {
    const allowed = input.wire.choices.map((choice) => choice.value);
    const choice = raw.choice;
    if (typeof choice !== "string" || !allowed.includes(choice)) {
      return abstain("invalid_response", `The choice answer '${String(choice)}' is not one of the defined values.`);
    }
    const confidence = finiteProbability(raw.confidence);
    return {
      ...base,
      status: "answered",
      choice,
      answer: choice,
      probabilities: distribution(raw.probabilities, "value"),
      confidence,
      semantics: "categorical",
      calibrationStatus: "uncalibrated",
    };
  }

  const levels = input.wire.levels;
  const score = raw.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels.length - 1) {
    return abstain("invalid_response", `The score answer is not an index within the ${levels.length} defined levels.`);
  }
  const legend: Record<string, string> = {};
  levels.forEach((level, index) => {
    legend[String(index)] = level.label;
  });
  return {
    ...base,
    status: "answered",
    score,
    answer: score,
    probabilities: distribution(raw.probabilities, "label"),
    confidence: finiteProbability(raw.confidence),
    legend,
    semantics: "ordered_score",
    calibrationStatus: "uncalibrated",
  };
}

function usageOf(value: unknown): DecisionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    totalTokens: num(usage.total_tokens),
    reasoningTokens: num(outputDetails.reasoning_tokens),
    cachedInputTokens: num(inputDetails.cached_tokens),
  };
}

function failureKindForStatus(status: number, body: string): DecisionFailureKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if ((status === 400 || status === 404) && /model/i.test(body)) return "unknown_model";
  if (status >= 500) return "provider_unavailable";
  return "invalid_request";
}

function retryable(kind: DecisionFailureKind): boolean {
  return kind === "rate_limited" || kind === "provider_unavailable";
}

/** Error text without anything that looks like a key. Provider error bodies are truncated. */
function safeErrorText(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…").slice(0, 300);
}

export class OpenAiDecisionsEngine implements DecisionEngine {
  readonly id = "openai-decisions" as const;
  readonly adapterVersion = OPENAI_DECISIONS_ADAPTER_VERSION;
  private readonly overrides: Partial<OpenAiDecisionsConfig>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    config?: Partial<OpenAiDecisionsConfig>;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.overrides = options.config ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private config(apiKey = ""): OpenAiDecisionsConfig {
    return { ...resolveOpenAiDecisionsConfig(this.overrides), apiKey };
  }

  /**
   * The key for one workspace. A key given to the constructor is used as given (explicit wiring and tests). Otherwise the
   * workspace's saved OpenAI key is read through the resolver, and the deployment key only when OPENAI_SHARED_DEFAULT opts in.
   */
  private async keyFor(organizationId: string | undefined): Promise<{ key: string; reason: string }> {
    if (this.overrides.apiKey) return { key: this.overrides.apiKey, reason: "" };
    const resolved = await secretForCategory("openai", organizationId);
    return { key: resolved.secret ?? "", reason: resolved.reason };
  }

  capabilities(): DecisionCapabilities {
    return {
      engineId: this.id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: ["text", "image"],
      maxImages: OPENAI_DECISIONS_MAX_IMAGES,
      maxImageBytes: OPENAI_DECISIONS_MAX_IMAGE_BYTES,
      imageMimeTypes: [...ACCEPTED_IMAGE_TYPES],
      batchQuestions: true,
      reportsUsage: true,
      semantics: {
        predicate: "probability",
        choice: "categorical_with_confidence",
        score: "ordered_level_expectation",
      },
    };
  }

  async health(organizationId?: string): Promise<DecisionEngineHealth> {
    const { key, reason } = await this.keyFor(organizationId);
    const config = this.config(key);
    if (!config.apiKey) return { status: "NOT_CONFIGURED", message: reason || "No OpenAI key is saved for this workspace." };
    if (!config.model) return { status: "NOT_CONFIGURED", message: "OPENAI_DECISIONS_MODEL is empty." };
    return { status: "READY", message: `Credentials present for ${config.model}. No live request has been made.` };
  }

  healthFor(organizationId: string): Promise<DecisionEngineHealth> {
    return this.health(organizationId);
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = Date.now();
    const { key } = await this.keyFor(request.organizationId);
    const config = this.config(key);
    const runId = globalThis.crypto.randomUUID();
    const imageCount = request.images?.length ?? 0;
    const result = (fields: Partial<DecisionResult> & Pick<DecisionResult, "answers">): DecisionResult => ({
      runId,
      model: fields.returnedModel ?? config.model,
      provider: PROVIDER,
      inputHash: fields.inputHash ?? "not_sent",
      cached: false,
      latencyMs: Date.now() - started,
      engineId: this.id,
      adapterVersion: this.adapterVersion,
      requestedModel: config.model,
      returnedModel: fields.returnedModel ?? config.model,
      inputModality: imageCount > 0 ? "text+image" : "text",
      imageCount,
      imagesOmitted: 0,
      ...fields,
    });

    const health = await this.health(request.organizationId);
    if (health.status !== "READY") {
      return result({
        answers: abstainAll(request, { status: "not_configured", reason: health.message, model: config.model, provider: PROVIDER }),
        failure: { kind: "not_configured", message: health.message },
      });
    }

    const prepared = prepareImages(request.images);
    if (!prepared.ok) {
      return result({
        answers: abstainAll(request, { status: "unsupported", reason: prepared.reason, model: config.model, provider: PROVIDER }),
        failure: { kind: "unsupported_input", message: prepared.reason },
      });
    }

    // Evidence sufficiency is checked before anything is sent, exactly as for JEV.
    const availableEvidence = [
      ...((((request.state as Record<string, unknown>).availableEvidence as string[] | undefined) ?? [])),
      ...((request.state.records ?? []).flatMap((record) => record.availableEvidence ?? [])),
    ];
    const answers: Record<string, JevAnswer> = {};
    const asked: Array<{ key: string; spec: JevQuestionSpec; wire: WireQuestion }> = [];
    for (const [key, spec] of Object.entries(request.questions)) {
      const sufficiency = checkEvidenceSufficiency(spec, availableEvidence);
      if (!sufficiency.sufficient) {
        answers[key] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: config.model,
          provider: PROVIDER,
          status: "abstain_insufficient_evidence",
          evidenceRefs: [],
          abstainReason: `Missing required evidence: ${sufficiency.missing.join(", ")}`,
          evaluatedAt: new Date().toISOString(),
        };
        continue;
      }
      const wire = toWireQuestion(`q${asked.length + 1}`, spec);
      if ("unsupported" in wire) {
        answers[key] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: config.model,
          provider: PROVIDER,
          status: "unsupported",
          evidenceRefs: [],
          abstainReason: wire.unsupported,
          evaluatedAt: new Date().toISOString(),
        };
        continue;
      }
      asked.push({ key, spec, wire });
    }
    if (asked.length === 0) return result({ answers });

    const input = buildInput(decisionContextText(request), prepared.images);
    const body: Record<string, unknown> = {
      model: config.model,
      input,
      questions: asked.map((entry) => entry.wire),
    };
    if (request.organizationId) {
      // A stable, non-identifying tenant handle for the provider's abuse monitoring.
      body.safety_identifier = createHash("sha256").update(`meridian:${request.organizationId}`).digest("hex").slice(0, 64);
    }
    const payload = JSON.stringify(body);
    // The hash covers what was sent except the image bytes, which are hashed separately so the hash stays small.
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ model: config.model, questions: body.questions, text: decisionContextText(request) }))
      .update(prepared.images.map((image) => createHash("sha256").update(image.dataUrl).digest("hex")).join(","))
      .digest("hex");

    const fail = (kind: DecisionFailureKind, message: string): DecisionResult => {
      for (const entry of asked) {
        answers[entry.key] = {
          questionId: entry.spec.id,
          questionVersion: entry.spec.version,
          type: entry.spec.type,
          model: config.model,
          provider: PROVIDER,
          status: kind === "invalid_response" ? "invalid_response" : "provider_error",
          evidenceRefs: [],
          abstainReason: message,
          evaluatedAt: new Date().toISOString(),
        };
      }
      return result({ answers, inputHash, failure: { kind, message } });
    };

    let response: Response | undefined;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      try {
        response = await this.fetchImpl(`${config.baseUrl}/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: payload,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        // A timed-out request may have been processed and billed, so it is not retried.
        if (timedOut) return fail("timeout", `OpenAI Decisions did not respond within ${config.timeoutMs} ms.`);
        if (attempt < config.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        return fail("network", `OpenAI Decisions request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) break;
      const text = safeErrorText(await response.text().catch(() => ""));
      const kind = failureKindForStatus(response.status, text);
      if (retryable(kind) && attempt < config.maxRetries) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      return fail(kind, `OpenAI Decisions returned HTTP ${response.status}: ${text}`);
    }
    if (!response?.ok) return fail("provider_unavailable", "OpenAI Decisions did not return a response.");

    let decoded: Record<string, unknown>;
    try {
      decoded = (await response.json()) as Record<string, unknown>;
    } catch {
      return fail("invalid_response", "OpenAI Decisions returned a body that is not JSON.");
    }
    if (!decoded || !Array.isArray(decoded.answers)) {
      return fail("invalid_response", "OpenAI Decisions returned no answers array.");
    }
    const returnedModel = typeof decoded.model === "string" && decoded.model ? decoded.model : config.model;
    const byName = new Map<string, unknown>();
    for (const raw of decoded.answers as unknown[]) {
      const name = raw && typeof raw === "object" ? (raw as Record<string, unknown>).name : undefined;
      if (typeof name === "string" && !byName.has(name)) byName.set(name, raw);
    }
    for (const entry of asked) {
      answers[entry.key] = normalizeAnswer({
        key: entry.key,
        spec: entry.spec,
        wire: entry.wire,
        raw: byName.get(entry.wire.name),
        model: returnedModel,
      });
    }
    return result({ answers, inputHash, returnedModel, usage: usageOf(decoded.usage) });
  }
}
