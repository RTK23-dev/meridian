/**
 * Image generators behind the durable production lifecycle (P4b-2).
 *
 * An image generator is synchronous: one call returns the bytes. The durable job still wraps it. The job row and the
 * budget reservation exist before the call, and the bytes are stored and verified by the shared artifact finalizer
 * after it. The generator never writes creative, asset, or review rows.
 */
import type { ProviderHealth } from "./types.ts";
import { generateImageBytes } from "../providers/image-bytes.server.ts";
import { generateNanoBananaImage } from "../providers/nano-banana.server.ts";
import type { Sql } from "../learning/store.ts";
import { loadDefaultSql, resolveCredential, type CredentialEnv } from "../credentials/resolve.ts";
import { credentialStateOf, type CredentialResolution } from "../credentials/contract.ts";
import { isTestingRuntimeNow as testingRuntimeNow } from "../runtime-mode.ts";

export interface ImageGenerationInput {
  prompt: string;
  seed: string;
  promptVersion: string;
  /** The registry model the capability matrix selected. */
  model: string;
  aspectRatio: string;
  /**
   * The workspace that owns the image. The Google provider uses that workspace's production credential. Without it, the
   * provider makes no request.
   */
  organizationId?: string;
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
  health(): Promise<ProviderHealth>;
  generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome>;
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

/**
 * Google's image model. It uses the workspace's own production credential, resolved per call from the image's organization.
 * The deployment key is used only when PRODUCTION_SHARED_DEFAULT=deployment is set.
 */
export class GoogleNanoBananaImageProvider implements ProductionImageProvider {
  readonly id = "google_nano_banana";
  readonly capabilities = { zeroSpend: false };
  private readonly sql?: Sql;
  private readonly env?: CredentialEnv;
  private readonly fetchImpl?: typeof fetch;
  private readonly lookup?: (organizationId: string) => Promise<CredentialResolution>;

  constructor(options?: {
    sql?: Sql;
    env?: CredentialEnv;
    fetchImpl?: typeof fetch;
    lookup?: (organizationId: string) => Promise<CredentialResolution>;
  }) {
    this.sql = options?.sql;
    this.env = options?.env;
    this.fetchImpl = options?.fetchImpl;
    this.lookup = options?.lookup;
  }

  private async credentialFor(organizationId: string): Promise<CredentialResolution> {
    if (this.lookup) return this.lookup(organizationId);
    const sql = this.sql ?? (await loadDefaultSql());
    return resolveCredential(sql, organizationId, "production", this.env ?? process.env);
  }

  /** Without a workspace there is no key to check, so this reports only that a workspace credential is needed. */
  async health(): Promise<ProviderHealth> {
    return health(this.id, false, "Google image generation needs a workspace production credential. Readiness is checked for a workspace, and none was given.");
  }

  /** Readiness for one workspace. A workspace whose key is not usable is never reported as ready. */
  async healthFor(organizationId: string): Promise<ProviderHealth> {
    let state: ReturnType<typeof credentialStateOf>;
    try {
      state = credentialStateOf(await this.credentialFor(organizationId));
    } catch {
      return health(this.id, false, "The workspace's Google production credential could not be checked.");
    }
    if (state.state !== "usable") return health(this.id, false, state.reason ?? "No Google production credential is available for this workspace.");
    const source = state.source === "workspace" ? "this workspace's saved key" : "the deployment's shared default key";
    return health(this.id, true, `Google image generation uses ${source}.`);
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome> {
    const provider = "google:nano-banana";
    if (!input.organizationId) {
      return { status: "NOT_CONNECTED", provider, error: "Google image generation needs a workspace production credential, and no workspace was given. No image was generated." };
    }
    let resolution: CredentialResolution;
    try {
      resolution = await this.credentialFor(input.organizationId);
    } catch {
      return { status: "NOT_CONNECTED", provider, error: "The workspace's Google production credential could not be read. No image was generated." };
    }
    if (resolution.status !== "ready") {
      return { status: "NOT_CONNECTED", provider, error: resolution.reason };
    }
    // The key goes only to this request. The bytes are returned to the caller, which stores and verifies them.
    const result = await generateNanoBananaImage({
      prompt: input.prompt,
      promptVersion: input.promptVersion,
      model: input.model,
      aspectRatio: input.aspectRatio,
      apiKey: resolution.secret,
      fetchImpl: this.fetchImpl,
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
