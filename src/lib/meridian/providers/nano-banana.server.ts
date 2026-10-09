import { createHash } from "node:crypto";
import { inspectImage } from "../assets/images.ts";
import type { ImageResult } from "./media.ts";
import { ProviderConfigResolver } from "../config/resolver.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

export interface NormalizedImageBlock {
  dataBase64?: string;
  uri?: string;
  mimeType: string;
}

/**
 * Normalizes Google Gemini Interactions REST response into a typed image block.
 * Handles documented interaction steps[].content[] schema as well as compatibility envelopes.
 */
export function normalizeGoogleImageResponse(body: unknown): NormalizedImageBlock | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Google Interactions response is not a valid JSON object." };
  }

  const obj = body as Record<string, unknown>;

  // Check for explicit API error
  if (obj.error && typeof obj.error === "object") {
    const apiErr = obj.error as Record<string, unknown>;
    return { error: `Google API error: ${apiErr.message || JSON.stringify(apiErr)}` };
  }

  // 1. Documented raw schema: steps[].content[] where type === 'image'
  if (Array.isArray(obj.steps)) {
    for (const step of obj.steps) {
      if (typeof step === "object" && step !== null) {
        const stepObj = step as Record<string, unknown>;
        const content = stepObj.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null) {
              const blk = block as Record<string, unknown>;
              if (blk.type === "image" || blk.image) {
                const data = typeof blk.data === "string" && blk.data.trim() ? blk.data.trim() : undefined;
                const uri = typeof blk.uri === "string" && blk.uri.trim() ? blk.uri.trim() : undefined;
                const mimeType = typeof blk.mime_type === "string" ? blk.mime_type : "image/png";
                if (data || uri) {
                  return { dataBase64: data, uri, mimeType };
                }
              }
            }
          }
        }
      }
    }
  }

  // 2. Compatibility schema: outputs[].type === 'image'
  if (Array.isArray(obj.outputs)) {
    for (const out of obj.outputs) {
      if (typeof out === "object" && out !== null) {
        const outObj = out as Record<string, unknown>;
        if (outObj.type === "image") {
          const data = typeof outObj.data === "string" && outObj.data.trim() ? outObj.data.trim() : undefined;
          const uri = typeof outObj.uri === "string" && outObj.uri.trim() ? outObj.uri.trim() : undefined;
          const mimeType = typeof outObj.mime_type === "string" ? outObj.mime_type : "image/png";
          if (data || uri) {
            return { dataBase64: data, uri, mimeType };
          }
        }
      }
    }
  }

  // 3. Compatibility schema: output_image
  if (obj.output_image && typeof obj.output_image === "object") {
    const imgObj = obj.output_image as Record<string, unknown>;
    const data = typeof imgObj.data === "string" && imgObj.data.trim() ? imgObj.data.trim() : undefined;
    const uri = typeof imgObj.uri === "string" && imgObj.uri.trim() ? imgObj.uri.trim() : undefined;
    const mimeType = typeof imgObj.mime_type === "string" ? imgObj.mime_type : "image/png";
    if (data || uri) {
      return { dataBase64: data, uri, mimeType };
    }
  }

  return { error: "Google Interactions response did not contain an image content block." };
}

/** Google AI Studio image adapter with documented Interactions REST parsing. */
export async function generateNanoBananaImage(input: {
  prompt: string;
  promptVersion: string;
  model?: string;
  aspectRatio?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<ImageResult> {
  const resolved = ProviderConfigResolver.resolveGoogle({ env: input.env });
  const apiKey = resolved.apiKey;
  if (!apiKey) {
    return {
      status: "NOT_CONNECTED",
      provider: "google:nano-banana",
      error: "Google Gemini image credentials are not configured (MERIDIAN_GEMINI_API_KEY). Image generation is optional; no image was created.",
    };
  }

  const model = input.env?.GOOGLE_NANO_BANANA_MODEL?.trim() || resolved.imageModel;
  if (input.model && input.model !== model) {
    return {
      status: "failed",
      provider: "google:nano-banana",
      error: `CreativePlan model '${input.model}' does not match configured image model '${model}'. No image was generated.`,
    };
  }
  const started = Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        input: input.prompt,
        response_format: {
          type: "image",
          mime_type: "image/png",
          aspect_ratio: input.aspectRatio || "9:16",
          image_size: "1K",
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        status: "failed",
        provider: "google:nano-banana",
        error: `Google AI Studio returned ${response.status}: ${errText.slice(0, 200)}. No image was stored.`,
      };
    }

    const body = await response.json();
    const normalized = normalizeGoogleImageResponse(body);

    if ("error" in normalized) {
      return {
        status: "failed",
        provider: "google:nano-banana",
        error: `Google AI Studio response parsing failed: ${normalized.error}`,
      };
    }

    let bytes: Uint8Array;
    if (normalized.dataBase64) {
      try {
        bytes = new Uint8Array(Buffer.from(normalized.dataBase64, "base64"));
      } catch {
        return {
          status: "failed",
          provider: "google:nano-banana",
          error: "Google AI Studio returned malformed base64 image data.",
        };
      }
    } else if (normalized.uri) {
      const uriRes = await fetchImpl(normalized.uri);
      if (!uriRes.ok) {
        return {
          status: "failed",
          provider: "google:nano-banana",
          error: `Failed to download image from Google URI: ${normalized.uri} (${uriRes.status})`,
        };
      }
      bytes = new Uint8Array(await uriRes.arrayBuffer());
    } else {
      return {
        status: "failed",
        provider: "google:nano-banana",
        error: "Google AI Studio returned no image bytes.",
      };
    }

    if (bytes.byteLength === 0) {
      return {
        status: "failed",
        provider: "google:nano-banana",
        error: "Google AI Studio returned 0 image bytes.",
      };
    }

    const inspected = inspectImage(bytes);
    if (!inspected.ok || inspected.mime !== "image/png") {
      return {
        status: "failed",
        provider: "google:nano-banana",
        error: inspected.ok ? "Google AI Studio did not return the requested PNG." : inspected.detail,
      };
    }

    const width = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
    const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);

    if (width < 1 || height < 1) {
      return {
        status: "failed",
        provider: "google:nano-banana",
        error: "Google AI Studio returned invalid image dimensions.",
      };
    }

    return {
      status: "ready",
      provider: "google:nano-banana",
      model,
      prompt: input.prompt,
      promptVersion: input.promptVersion,
      objectKey: "",
      bytes,
      mediaType: "image/png",
      width,
      height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      latencyMs: Date.now() - started,
      costCents: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      provider: "google:nano-banana",
      error: `Google AI Studio could not be reached: ${message}. No image was stored.`,
    };
  }
}
