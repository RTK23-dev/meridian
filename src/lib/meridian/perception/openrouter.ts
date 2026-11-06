/**
 * Reference analysis through the workspace's OpenRouter key: the same instructions and the same strict reading of the answer as the
 * Gemini provider (multimodal.ts), sent to the model the workspace chose for "Reference analysis" in Settings.
 *
 * The call goes through the ordinary generation path (providers/chat.server.ts), so it has the same guards as every other OpenRouter text
 * call: the model is checked against the live catalogue and must take images, the call's worst case is bounded and held in the ledger
 * before it is sent, it is refused above the per-call ceiling or the month's budget, and its settlement records the cost OpenRouter
 * reports. The spend is recorded there, so the perception runner does not record it again.
 *
 * Observations are the model's inferences. An answer that is not a JSON array with one entry for each item, by index, is a failure,
 * never a guess. Only the media and the fixed instructions are sent: no copy, prompt, brand or competitor text.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { checkImageBytes } from "../media/image-input.ts";
import { completeGenerationTask, generationCredentialStatus, type GenerationResult } from "../providers/chat.server.ts";
import type { ContentPart } from "../providers/generation-ledger.ts";
import { GEMINI_PERCEPTION_MAX_MEDIA, parseGeminiObservations, perceptionInstructions } from "./multimodal.ts";
import type {
  MultimodalPerceptionProvider,
  PerceptionCallContext,
  PerceptionCredentialCheck,
  PerceptionFailureKind,
  PerceptionHealth,
  PerceptionMedia,
  PerceptionMediaKind,
  PerceptionResult,
} from "./types.ts";

export const OPENROUTER_PERCEPTION_ID = "openrouter_multimodal";
export const OPENROUTER_PERCEPTION_PROMPT_VERSION = "openrouter-perception.v1";
/** The longest answer a read may return. Four items of the fields asked for fit well inside it. */
export const OPENROUTER_PERCEPTION_MAX_TOKENS = 2_000;

const SYSTEM =
  "You describe what is visible in images for an advertising production tool. Report only what the pixels show. Answer with JSON only.";

type Complete = typeof completeGenerationTask;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The answer's JSON array: the text itself, inside a code fence, or under an `observations` key. Anything else is left for the parser to refuse. */
export function perceptionAnswerText(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? trimmed;
  try {
    const value: unknown = JSON.parse(fenced);
    if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { observations?: unknown }).observations)) {
      return JSON.stringify((value as { observations: unknown[] }).observations);
    }
  } catch {
    // Not JSON as a whole: the parser reports it.
  }
  return fenced;
}

/** How a failed generation call reads as a perception failure. An uncertain call may have been billed, and its hold stays. */
function failureKindOf(result: Extract<GenerationResult, { ok: false }>): PerceptionFailureKind {
  if (result.status === "unavailable") return /choose a model|no model is chosen|not chosen/i.test(result.error) ? "not_configured" : "provider_unavailable";
  if (/timed out|timeout/i.test(result.error)) return "timeout";
  if (/401|403|unauthor|forbidden/i.test(result.error)) return "authentication";
  if (/429|rate/i.test(result.error)) return "rate_limited";
  return "provider_unavailable";
}

export class OpenRouterPerceptionProvider implements MultimodalPerceptionProvider {
  readonly id = OPENROUTER_PERCEPTION_ID;
  readonly promptVersion = OPENROUTER_PERCEPTION_PROMPT_VERSION;
  /** The generation path holds and settles the call's cost, so the runner records no separate spend for it. */
  readonly meteredElsewhere = true;
  readonly model: string;
  private readonly complete: Complete;
  private readonly credentialStatus: typeof generationCredentialStatus;

  constructor(model: string, deps: { complete?: Complete; credentialStatus?: typeof generationCredentialStatus } = {}) {
    this.model = model;
    this.complete = deps.complete ?? completeGenerationTask;
    this.credentialStatus = deps.credentialStatus ?? generationCredentialStatus;
  }

  async health(): Promise<PerceptionHealth> {
    return { id: this.id, state: "HEALTHY", detail: `OpenRouter reference analysis ready (model ${this.model}). The key is resolved per request.` };
  }

  /** The workspace's OpenRouter key, from the credential resolver. No request is made. */
  async resolveCredential(_sql: Sql, organizationId: string): Promise<PerceptionCredentialCheck> {
    const state = await this.credentialStatus(organizationId);
    if (state.status === "ready") return { status: "ready", source: "openrouter", apiKey: "" };
    return { status: state.status === "unusable" ? "unusable" : "not_configured", reason: state.reason };
  }

  async perceive(input: { kind: PerceptionMediaKind; media: PerceptionMedia[] }, options: { apiKey: string; context?: PerceptionCallContext }): Promise<PerceptionResult> {
    const started = Date.now();
    const failed = (failureKind: PerceptionFailureKind, message: string, model = this.model): PerceptionResult => ({
      status: "failed",
      providerId: this.id,
      model,
      promptVersion: this.promptVersion,
      failureKind,
      message,
      latencyMs: Date.now() - started,
    });
    const context = options.context;
    if (!context) return failed("not_configured", "No workspace is in scope, so no budget can be held and nothing is sent.");
    if (input.media.length === 0) return failed("no_media", "No media was supplied.");
    if (input.media.length > GEMINI_PERCEPTION_MAX_MEDIA) {
      return failed("unsupported_media", `At most ${GEMINI_PERCEPTION_MAX_MEDIA} media items per call; ${input.media.length} were supplied.`);
    }
    for (const [index, item] of input.media.entries()) {
      const checked = checkImageBytes(item.bytes, `Media ${index + 1}`);
      if (!checked.ok) return failed("unsupported_media", checked.reason);
      if (checked.mimeType !== item.mimeType) return failed("unsupported_media", `Media ${index + 1} is ${checked.mimeType}, not the ${item.mimeType} it was recorded as.`);
      if (sha256Hex(item.bytes) !== item.sha256) return failed("unsupported_media", `Media ${index + 1} does not match its recorded hash.`);
    }

    const user: ContentPart[] = [
      { type: "text", text: perceptionInstructions(input.kind, input.media.length) },
      ...input.media.map((item): ContentPart => ({ type: "image_url", image_url: { url: `data:${item.mimeType};base64,${Buffer.from(item.bytes).toString("base64")}` } })),
    ];
    const result = await this.complete(context.organizationId, "reference_analysis", {
      system: SYSTEM,
      user,
      maxTokens: OPENROUTER_PERCEPTION_MAX_TOKENS,
      temperature: 0.1,
      record: {
        sql: context.sql,
        brandId: context.brandId,
        correlationId: context.runId,
        operation: "perception.observe",
        promptId: "perception",
        promptVersion: this.promptVersion,
        inputRef: `perception:${input.media.map((item) => item.sha256).join(",")}`,
      },
    });
    if (!result.ok) return failed(failureKindOf(result), result.error, result.model ?? this.model);

    const model = result.returnedModel ?? result.model;
    const parsed = parseGeminiObservations(perceptionAnswerText(result.content), input.media);
    if (!parsed.ok) return failed("invalid_response", parsed.reason, model);
    return {
      status: "observed",
      providerId: this.id,
      model,
      promptVersion: this.promptVersion,
      observations: parsed.observations,
      latencyMs: result.latencyMs,
    };
  }
}
