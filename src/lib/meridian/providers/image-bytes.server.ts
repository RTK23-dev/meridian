import { testImageProvider, type ImageResult } from "./media.ts";
import { generateNanoBananaImage } from "./nano-banana.server.ts";

/**
 * Image bytes for Studio. Live image generation is optional and isolated from JEV/Hypit.
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
  if (input.provider === "google:nano-banana") {
    return generateNanoBananaImage({ prompt: input.prompt, promptVersion: input.promptVersion });
  }
  return { status: "NOT_CONNECTED", provider: input.provider || "unconfigured", error: "The selected image provider is unavailable. No image was generated." };
}
