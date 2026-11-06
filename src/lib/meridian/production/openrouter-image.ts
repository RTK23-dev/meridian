/**
 * Studio images through the workspace's OpenRouter key (owner direction 2026-11-06), with the image model the workspace chose under Settings,
 * Models ("Studio image model"). It is a Studio image provider like Google's Nano Banana: the durable job and its budget reservation exist
 * before the call, and the shared finalizer stores and verifies the bytes after it.
 *
 * The call goes through the engine's gateway (gateway/gateway.ts), which adds the workspace's key and sends it only to OpenRouter. The
 * request is OpenRouter's image endpoint, as the video engine sends it (engine/assets/providers/openrouterImage.ts). The answer is untrusted:
 * the image must decode, be a PNG by its own bytes, and state its size. A cost is recorded only when OpenRouter reports one. The provider is
 * ready for a workspace only when its key is usable and a Studio image model is chosen; without a choice it is not used, and the workspace's
 * other image providers apply.
 */
import { createGateway, type Gateway } from "../../../engine/gateway/gateway.ts";
import { fetchHttpTransport } from "../../../engine/gateway/transport.ts";
import { meridianCredentialSource } from "../../../engine/gateway/meridian.ts";
import { detectArtifactType } from "./mime-detector.ts";
import { generationCredentialStatus } from "../providers/chat.server.ts";
import { storedMediaModel } from "../settings/media-models.ts";
import { loadDefaultSql } from "../credentials/resolve.ts";
import type { ProviderHealth } from "./types.ts";
import type { ImageGenerationInput, ImageGenerationOutcome, ProductionImageProvider } from "./image-providers.ts";

export const OPENROUTER_IMAGE_PROVIDER_ID = "openrouter_image";
/** The registry model id this provider is offered under: the image model the workspace chose, read when the image is made. */
export const OPENROUTER_IMAGE_SEAT_MODEL = "studio-image-model";
/** The outcome's provider label. */
const PROVIDER_LABEL = "openrouter:image";
/** An image call that gets no answer in this long is abandoned (the job's reservation stays held, as for any unknown outcome). */
export const OPENROUTER_IMAGE_TIMEOUT_MS = 120_000;
/** The most bytes one generated image may weigh. A larger answer is refused, not stored. */
export const OPENROUTER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * The aspect ratios the recorded image endpoint names (docs/engine/PROVIDER_APIS.md, "Images: POST /images": 1:1, 9:16, 16:9). The full
 * set per model is not stated, so any other ratio is refused before a call rather than sent on a guess.
 */
export const OPENROUTER_IMAGE_ASPECT_RATIOS = ["1:1", "9:16", "16:9"] as const;

type Deps = {
  gateway?: Pick<Gateway, "call">;
  stored?: (organizationId: string) => Promise<string | null>;
  credentialStatus?: typeof generationCredentialStatus;
};

let defaultGatewayCache: Gateway | null = null;
function defaultGateway(): Gateway {
  defaultGatewayCache ??= createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });
  return defaultGatewayCache;
}

async function defaultStored(organizationId: string): Promise<string | null> {
  return storedMediaModel(await loadDefaultSql(), organizationId, "studio_image");
}

function health(configured: boolean, detail: string): ProviderHealth {
  return { id: OPENROUTER_IMAGE_PROVIDER_ID, state: configured ? "CONFIGURED" : "NOT_CONFIGURED", capabilities: ["text-to-image"], detail, checkedAt: new Date().toISOString() };
}

type ImageAnswer = { data?: Array<{ b64_json?: unknown; media_type?: unknown }>; usage?: { cost?: unknown } };

/** Strict base64: anything that is not base64 is refused rather than decoded loosely. */
function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** The width and height a PNG states in its header, or null when it does not state a usable size. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The cost OpenRouter reported, in cents, or null when it reported none. Never an estimate. */
function reportedCents(usage: ImageAnswer["usage"]): number | null {
  const cost = usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost * 100 : null;
}

export class OpenRouterStudioImageProvider implements ProductionImageProvider {
  readonly id = OPENROUTER_IMAGE_PROVIDER_ID;
  /** No per-image price is declared: each model has its own, so the job runs under its reserved spend cap, as Google's provider does. */
  readonly capabilities = { zeroSpend: false };
  private readonly deps: Deps;

  constructor(deps: Deps = {}) {
    this.deps = deps;
  }

  private stored(organizationId: string): Promise<string | null> {
    return (this.deps.stored ?? defaultStored)(organizationId);
  }

  /** Without a workspace there is no key and no chosen model to check. */
  async health(): Promise<ProviderHealth> {
    return health(false, "OpenRouter Studio images need a workspace: its OpenRouter key and its Studio image model.");
  }

  /** Ready only with a usable OpenRouter key and a chosen Studio image model. No request is made. */
  async healthFor(organizationId: string): Promise<ProviderHealth> {
    let model: string | null;
    try {
      model = await this.stored(organizationId);
    } catch {
      return health(false, "The workspace's Studio image model could not be read.");
    }
    if (!model) return health(false, "No Studio image model is chosen in Settings, Models, so OpenRouter does not make Studio images.");
    const key = await (this.deps.credentialStatus ?? generationCredentialStatus)(organizationId);
    if (key.status !== "ready") return health(false, key.reason);
    return health(true, `Studio images use ${model} through the workspace's OpenRouter key.`);
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome> {
    const notConnected = (error: string): ImageGenerationOutcome => ({ status: "NOT_CONNECTED", provider: PROVIDER_LABEL, error });
    if (!input.organizationId) return notConnected("OpenRouter Studio images need a workspace, and none was given. No image was generated.");
    if (!(OPENROUTER_IMAGE_ASPECT_RATIOS as readonly string[]).includes(input.aspectRatio)) {
      return notConnected(`OpenRouter's image endpoint is recorded for 1:1, 9:16 and 16:9 only, not ${input.aspectRatio}. No image was generated.`);
    }
    let model: string | null;
    try {
      model = await this.stored(input.organizationId);
    } catch {
      return notConnected("The workspace's Studio image model could not be read. No image was generated.");
    }
    if (!model) return notConnected("No Studio image model is chosen in Settings, Models. No image was generated.");

    let result;
    try {
      result = await (this.deps.gateway ?? defaultGateway()).call({
        provider: "openrouter",
        organizationId: input.organizationId,
        method: "POST",
        path: "/images",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: input.prompt, n: 1, aspect_ratio: input.aspectRatio, output_format: "png" }),
        timeoutMs: OPENROUTER_IMAGE_TIMEOUT_MS,
      });
    } catch (error) {
      // The request may have reached OpenRouter, so this is a failure (the reservation is held), not a refusal.
      return { status: "failed", provider: PROVIDER_LABEL, error: `The image request did not complete: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}.` };
    }
    if (result.status === "not_connected") return notConnected(result.reason);
    const response = result.response;
    if (response.status < 200 || response.status >= 300) {
      return { status: "failed", provider: PROVIDER_LABEL, error: `OpenRouter answered the image request with HTTP ${response.status}.` };
    }
    let answer: ImageAnswer;
    try {
      answer = JSON.parse(new TextDecoder().decode(response.body)) as ImageAnswer;
    } catch {
      return { status: "failed", provider: PROVIDER_LABEL, error: "OpenRouter's image answer was not JSON." };
    }
    const costCents = reportedCents(answer.usage);
    const failed = (error: string): ImageGenerationOutcome => ({ status: "failed", provider: PROVIDER_LABEL, error });
    const bytes = decodeBase64(answer.data?.[0]?.b64_json);
    if (!bytes) return failed("OpenRouter's image answer carried no readable image.");
    if (bytes.byteLength > OPENROUTER_IMAGE_MAX_BYTES) return failed(`The image is ${bytes.byteLength} bytes; the limit is ${OPENROUTER_IMAGE_MAX_BYTES}.`);
    let mediaType: string;
    try {
      mediaType = detectArtifactType(bytes).mimeType;
    } catch {
      return failed("OpenRouter's image is not a readable image.");
    }
    if (mediaType !== "image/png") return failed(`OpenRouter returned ${mediaType}, not the PNG that was asked for.`);
    const size = pngSize(bytes);
    if (!size) return failed("OpenRouter's image states no usable size.");
    return { status: "ready", provider: PROVIDER_LABEL, model, promptVersion: input.promptVersion, mediaType, bytes, width: size.width, height: size.height, costCents };
  }
}
