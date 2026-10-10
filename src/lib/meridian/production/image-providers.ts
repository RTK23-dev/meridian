/**
 * Image generators behind the durable production lifecycle (P4b-2).
 *
 * An image generator is synchronous: one call returns the bytes. The durable job still wraps it. The job row and the
 * budget reservation exist before the call, and the bytes are stored and verified by the shared artifact finalizer
 * after it. The generator never writes creative, asset, or review rows.
 */
import type { ProductionCallContext, ProviderHealth } from "./types.ts";
import { generateImageBytes } from "../providers/image-bytes.server.ts";
import { isTestingRuntimeNow as testingRuntimeNow } from "../runtime-mode.ts";

export interface ImageGenerationInput {
  prompt: string;
  seed: string;
  promptVersion: string;
  /** The registry model the capability matrix selected. */
  model: string;
  aspectRatio: string;
}

export type ImageGenerationOutcome =
  | {
      status: "ready";
      provider: string;
      model: string;
      promptVersion: string;
      mediaType: string;
      bytes: Uint8Array;
      width: number;
      height: number;
    }
  /** No credentials: the provider was never called, so nothing was submitted and nothing can be billed. */
  | { status: "NOT_CONNECTED"; provider: string; error: string }
  /** The call returned a failure. It may have reached the provider, so the reservation is held, not released. */
  | { status: "failed"; provider: string; error: string };

export interface ProductionImageProvider {
  /** The registry provider id, for example `google_nano_banana`. */
  readonly id: string;
  readonly capabilities: {
    zeroSpend: boolean;
    /** Declared per-image price. Absent means no image price is declared, so the cost is unknown. */
    costPerImageEstimateUsd?: number;
  };
  health(context?: ProductionCallContext): Promise<ProviderHealth>;
  generate(input: ImageGenerationInput, context?: ProductionCallContext): Promise<ImageGenerationOutcome>;
}

function health(id: string, configured: boolean, detail: string): ProviderHealth {
  return {
    id,
    state: configured ? "CONFIGURED" : "NOT_CONFIGURED",
    capabilities: ["text-to-image"],
    detail,
    checkedAt: new Date().toISOString(),
  };
}

/** Google's image model. Its adapter is selected only when Google credentials are configured. */
export class GoogleNanoBananaImageProvider implements ProductionImageProvider {
  readonly id = "google_nano_banana";
  readonly capabilities = { zeroSpend: false };

  async health(context?: ProductionCallContext): Promise<ProviderHealth> {
    const configured = Boolean(context?.googleKey);
    return health(this.id, configured, configured ? "Google image credentials are configured." : "Google image credentials are not configured.");
  }

  async generate(input: ImageGenerationInput, context?: ProductionCallContext): Promise<ImageGenerationOutcome> {
    const result = await generateImageBytes({
      provider: "google:nano-banana",
      prompt: input.prompt,
      seed: input.seed,
      promptVersion: input.promptVersion,
      allowTest: false,
      model: input.model,
      aspectRatio: input.aspectRatio,
      apiKey: context?.googleKey,
    });
    return toOutcome(result);
  }
}

/**
 * The deterministic test image double. It is usable only in the testing runtime, and that is checked on every call. Its
 * declared price is zero, because a test double costs nothing; that is a declaration of the double, not a price for any
 * real provider.
 */
export class TestImageProvider implements ProductionImageProvider {
  readonly id = "test:image";
  readonly capabilities = { zeroSpend: false, costPerImageEstimateUsd: 0 };

  async health(): Promise<ProviderHealth> {
    const enabled = testingRuntimeNow();
    return health(this.id, enabled, enabled ? "Test image double is enabled for this runtime." : "Test image double is disabled outside the testing runtime.");
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome> {
    const result = await generateImageBytes({
      provider: "test:image",
      prompt: input.prompt,
      seed: input.seed,
      promptVersion: input.promptVersion,
      allowTest: testingRuntimeNow(),
      model: input.model,
      aspectRatio: input.aspectRatio,
    });
    return toOutcome(result);
  }
}

type GeneratedImage = Awaited<ReturnType<typeof generateImageBytes>>;

function toOutcome(result: GeneratedImage): ImageGenerationOutcome {
  if (result.status === "ready") {
    return {
      status: "ready",
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      mediaType: result.mediaType,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
    };
  }
  if (result.status === "NOT_CONNECTED") return { status: "NOT_CONNECTED", provider: result.provider, error: result.error };
  return { status: "failed", provider: result.provider, error: result.error };
}
