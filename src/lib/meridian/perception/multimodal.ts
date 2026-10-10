/**
 * Gemini as the first multimodal perception provider, behind MultimodalPerceptionProvider.
 *
 * Observations are the model's descriptions of the media it was given. They are attached to the media by index, and only
 * when the model reports that index. A missing or malformed observation is a failure, not a guess. Nothing is invented:
 * no end time, no quality score, and no observation for media that was not analysed.
 *
 * The API key is sent in a request header, never in the URL, so it cannot appear in a log of the request.
 */
import { createHash } from "node:crypto";
import { ProviderConfigResolver } from "../config/resolver.ts";
import { checkImageBytes } from "../media/image-input.ts";
import type {
  MediaObservation,
  MultimodalPerceptionProvider,
  PerceptionFailureKind,
  PerceptionHealth,
  PerceptionMedia,
  PerceptionMediaKind,
  PerceptionResult,
} from "./types.ts";

export const GEMINI_PERCEPTION_PROMPT_VERSION = "gemini-perception.v1";
/** The most media one call may carry. A video is judged on at most this many frames, never on the whole video. */
export const GEMINI_PERCEPTION_MAX_MEDIA = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const SHOT_TYPES = ["close_up", "medium_shot", "wide_shot", "macro", "screen_recording", "unknown"] as const;
const SETTINGS = ["indoor", "outdoor", "studio", "vehicle", "screen", "unknown"] as const;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function instructions(kind: PerceptionMediaKind, count: number): string {
  const scope = kind === "video_frames"
    ? `These are ${count} frames sampled from one video, in time order. Describe each frame on its own. Do not describe what happens between frames.`
    : `This is ${count} image. Describe it on its own.`;
  return [
    "You are a factual visual perception system for advertising review. Describe only what is visible.",
    scope,
    "Return a JSON array with one object per item, in the order given. Each object has:",
    `- index: integer, 0 to ${count - 1}`,
    `- shotType: one of ${SHOT_TYPES.join(", ")}`,
    "- productPresence: boolean, true only if a product is visible",
    "- facePresence: boolean",
    "- presenterPresence: boolean",
    `- setting: one of ${SETTINGS.join(", ")}`,
    "- motionIntensity: number from 0 to 1, or null when a single still cannot show it",
    "- contrastRatio: number from 0 to 1",
    "- typographyDensity: number from 0 to 1",
    "- dominantColors: up to 5 colour names",
    "- ocrText: on-screen text transcribed exactly as shown, or an empty string when there is none",
    "Use null for anything you cannot see. Output only the JSON array.",
  ].join("\n");
}

type ParsedEntry = Omit<MediaObservation, "mediaId" | "sha256" | "timestampMs" | "basis">;

function sanitize(entry: Record<string, unknown>): ParsedEntry {
  const out: ParsedEntry = {};
  if (typeof entry.shotType === "string" && (SHOT_TYPES as readonly string[]).includes(entry.shotType)) {
    out.shotType = entry.shotType as ParsedEntry["shotType"];
  }
  if (typeof entry.productPresence === "boolean") out.productPresence = entry.productPresence;
  if (typeof entry.facePresence === "boolean") out.facePresence = entry.facePresence;
  if (typeof entry.presenterPresence === "boolean") out.presenterPresence = entry.presenterPresence;
  if (typeof entry.setting === "string" && (SETTINGS as readonly string[]).includes(entry.setting)) {
    out.setting = entry.setting as ParsedEntry["setting"];
  }
  for (const key of ["motionIntensity", "contrastRatio", "typographyDensity"] as const) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) out[key] = value;
  }
  if (Array.isArray(entry.dominantColors)) {
    const colours = entry.dominantColors.filter((item): item is string => typeof item === "string").slice(0, 5);
    if (colours.length > 0) out.dominantColors = colours;
  }
  if (typeof entry.ocrText === "string") {
    const text = entry.ocrText.trim().slice(0, 2000);
    if (text) out.ocrText = text;
  }
  return out;
}

/** Attaches each observation to the media at its index. Any missing, duplicate, or out-of-range index is a failure. */
export function parseGeminiObservations(
  text: string,
  media: PerceptionMedia[],
): { ok: true; observations: MediaObservation[] } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The response was not valid JSON." };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: "The response was not an array." };
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, reason: "An observation was not an object." };
    const index = (entry as { index?: unknown }).index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= media.length) {
      return { ok: false, reason: `An observation had index ${String(index)}, outside 0 to ${media.length - 1}.` };
    }
    if (byIndex.has(index)) return { ok: false, reason: `Index ${index} was reported more than once.` };
    byIndex.set(index, entry as Record<string, unknown>);
  }
  const observations: MediaObservation[] = [];
  for (const [index, item] of media.entries()) {
    const entry = byIndex.get(index);
    if (!entry) return { ok: false, reason: `No observation was reported for media ${index + 1}.` };
    observations.push({
      ...sanitize(entry),
      mediaId: item.id,
      sha256: item.sha256,
      timestampMs: item.timestampMs,
      basis: "model_description",
    });
  }
  return { ok: true, observations };
}

export class GeminiPerceptionProvider implements MultimodalPerceptionProvider {
  readonly id = "gemini_multimodal";
  readonly model: string;
  readonly promptVersion = GEMINI_PERCEPTION_PROMPT_VERSION;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKeyOverride: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    model = process.env.PERCEPTION_MODEL || "gemini-2.5-flash",
    options: { fetchImpl?: typeof fetch; apiKey?: string; timeoutMs?: number } = {},
  ) {
    this.model = model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiKeyOverride = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The canonical Gemini key, read the same way every other Gemini call reads it. */
  private apiKey(): string | undefined {
    return this.apiKeyOverride ?? ProviderConfigResolver.resolveGoogle({ env: process.env }).apiKey;
  }

  async health(): Promise<PerceptionHealth> {
    if (!this.apiKey()) {
      return { id: this.id, state: "NOT_CONFIGURED", detail: "MERIDIAN_GEMINI_API_KEY (or a documented alias) is not set." };
    }
    return { id: this.id, state: "HEALTHY", detail: `Gemini perception configured with model ${this.model}.` };
  }

  async perceive(input: { kind: PerceptionMediaKind; media: PerceptionMedia[] }): Promise<PerceptionResult> {
    const started = Date.now();
    const failed = (failureKind: PerceptionFailureKind, message: string): PerceptionResult => ({
      status: "failed",
      providerId: this.id,
      model: this.model,
      promptVersion: this.promptVersion,
      failureKind,
      message,
      latencyMs: Date.now() - started,
    });

    const key = this.apiKey();
    if (!key) return failed("not_configured", "MERIDIAN_GEMINI_API_KEY (or a documented alias) is not set.");
    if (input.media.length === 0) return failed("no_media", "No media was supplied.");
    if (input.media.length > GEMINI_PERCEPTION_MAX_MEDIA) {
      return failed("unsupported_media", `At most ${GEMINI_PERCEPTION_MAX_MEDIA} media items per call; ${input.media.length} were supplied.`);
    }
    for (const [index, item] of input.media.entries()) {
      const checked = checkImageBytes(item.bytes, `Media ${index + 1}`);
      if (!checked.ok) return failed("unsupported_media", checked.reason);
      if (checked.mimeType !== item.mimeType) {
        return failed("unsupported_media", `Media ${index + 1} is ${checked.mimeType}, not the ${item.mimeType} it was recorded as.`);
      }
      if (sha256Hex(item.bytes) !== item.sha256) return failed("unsupported_media", `Media ${index + 1} does not match its recorded hash.`);
    }

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: instructions(input.kind, input.media.length) },
            ...input.media.map((item) => ({ inlineData: { mimeType: item.mimeType, data: Buffer.from(item.bytes).toString("base64") } })),
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") return failed("timeout", `No response within ${this.timeoutMs} ms.`);
      return failed("network", "The request to the perception provider did not complete.");
    }
    if (!response.ok) {
      const kind: PerceptionFailureKind =
        response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "invalid_response";
      return failed(kind, `The perception provider returned HTTP ${response.status}.`);
    }

    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      return failed("invalid_response", "The response was not JSON.");
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || !text.trim()) return failed("invalid_response", "The response had no text.");
    const parsed = parseGeminiObservations(text, input.media);
    if (!parsed.ok) return failed("invalid_response", parsed.reason);

    const usage = data.usageMetadata;
    return {
      status: "observed",
      providerId: this.id,
      model: this.model,
      promptVersion: this.promptVersion,
      observations: parsed.observations,
      latencyMs: Date.now() - started,
      usage: usage
        ? { inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount, totalTokens: usage.totalTokenCount }
        : undefined,
    };
  }
}
