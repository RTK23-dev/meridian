import { testImageProvider, type ImageResult } from "./media.ts";

/**
 * Image bytes for the studio. xAI is imported only when that provider is selected.
 * A text model key is not an image model.
 */
export async function generateImageBytes(input: {
  provider: string;
  prompt: string;
  seed: string;
  promptVersion: string;
  allowTest: boolean;
}): Promise<ImageResult> {
  if (input.provider === "test:image") {
    return testImageProvider(input.allowTest).generate({
      prompt: input.prompt,
      seed: input.seed,
      promptVersion: input.promptVersion,
    });
  }
  if (input.provider !== "xai:image") {
    return { status: "failed", provider: input.provider || "unconfigured", error: "No image provider is selected. Nothing was generated." };
  }
  const { generateImage } = await import("./image.server.ts");
  const remote = await generateImage(input.prompt);
  if (!remote.ok) return { status: "failed", provider: "xai:image", error: remote.error };
  try {
    const response = await fetch(remote.url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return { status: "failed", provider: "xai:image", error: `Image bytes were not retrievable (${response.status}).` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 32) return { status: "failed", provider: "xai:image", error: "Image response was empty." };
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    if (!mime.startsWith("image/")) return { status: "failed", provider: "xai:image", error: "The provider did not return an image." };
    const { createHash } = await import("node:crypto");
    return {
      status: "ready",
      provider: "xai:image",
      model: "grok-imagine-image",
      prompt: input.prompt,
      promptVersion: input.promptVersion,
      objectKey: "",
      bytes,
      mediaType: mime,
      width: 0,
      height: 0,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      latencyMs: remote.latencyMs,
      costCents: null,
    };
  } catch {
    return { status: "failed", provider: "xai:image", error: "Image bytes could not be retrieved. The temporary URL was not stored as an asset." };
  }
}
