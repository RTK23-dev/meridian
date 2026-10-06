import { createHash } from "node:crypto";
import { inspectImage } from "../assets/images.ts";
import type { ImageResult } from "./media.ts";

const DEFAULT_MODEL = "gemini-3.1-flash-image";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Optional Google AI Studio image adapter. It only returns verified image bytes. */
export async function generateNanoBananaImage(input: {
  prompt: string;
  promptVersion: string;
  env?: { GOOGLE_AI_STUDIO_API_KEY?: string; GOOGLE_NANO_BANANA_MODEL?: string };
  fetchImpl?: typeof fetch;
}): Promise<ImageResult> {
  const env = input.env ?? process.env;
  const apiKey = env.GOOGLE_AI_STUDIO_API_KEY?.trim();
  if (!apiKey) return { status: "NOT_CONNECTED", provider: "google:nano-banana", error: "GOOGLE_AI_STUDIO_API_KEY is not configured. Image generation is optional; no image was created." };
  const model = env.GOOGLE_NANO_BANANA_MODEL?.trim() || DEFAULT_MODEL;
  const started = Date.now();
  try {
    const response = await (input.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model,
        input: input.prompt,
        response_format: { type: "image", mime_type: "image/png", aspect_ratio: "9:16", image_size: "1K" },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) return { status: "failed", provider: "google:nano-banana", error: `Google AI Studio returned ${response.status}. No image was stored.` };
    const body = await response.json() as { output_image?: { data?: unknown; mime_type?: unknown }; outputs?: { type?: string; data?: unknown; mime_type?: unknown }[] };
    const image = body.output_image ?? body.outputs?.find((output) => output.type === "image");
    if (typeof image?.data !== "string") return { status: "failed", provider: "google:nano-banana", error: "Google AI Studio returned no image bytes." };
    const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    const inspected = inspectImage(bytes);
    if (!inspected.ok || inspected.mime !== "image/png") return { status: "failed", provider: "google:nano-banana", error: inspected.ok ? "Google AI Studio did not return the requested PNG." : inspected.detail };
    const width = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
    const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
    if (width < 1 || height < 1) return { status: "failed", provider: "google:nano-banana", error: "Google AI Studio returned invalid image dimensions." };
    return {
      status: "ready", provider: "google:nano-banana", model, prompt: input.prompt, promptVersion: input.promptVersion,
      objectKey: "", bytes, mediaType: "image/png", width, height,
      sha256: createHash("sha256").update(bytes).digest("hex"), latencyMs: Date.now() - started, costCents: null,
    };
  } catch {
    return { status: "failed", provider: "google:nano-banana", error: "Google AI Studio could not be reached. No image was stored." };
  }
}
