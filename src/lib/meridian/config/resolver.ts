/**
 * Canonical Provider Configuration Resolver
 *
 * Implements centralized, server-only credential and model resolution across
 * settings, health checks, workers, and production providers.
 *
 * Rules:
 * - Precedence: Workspace Vault -> Canonical Env Var -> Documented Legacy Aliases -> Default.
 * - Masked display only (returns `...1234`), never raw secrets to browser or logs.
 * - Tenant isolation: Vault credentials strictly scoped to organization/brand.
 */

export interface GoogleProviderConfig {
  apiKey?: string;
  omniModel: string;
  imageModel: string;
  imageBatchModel: string;
  imagePremiumModel: string;
  source: "workspace_vault" | "environment" | "default";
  keyFingerprint?: string;
  isConfigured: boolean;
}

export interface ProviderSecretMask {
  fingerprint?: string;
  configured: boolean;
}

export function maskSecret(secret?: string): string | undefined {
  if (!secret || secret.trim().length < 4) return undefined;
  const clean = secret.trim();
  return `...${clean.slice(-4)}`;
}

export class ProviderConfigResolver {
  /**
   * Resolves Google AI credentials and model selections.
   * Canonical key: MERIDIAN_GEMINI_API_KEY
   * Documented aliases: GOOGLE_AI_STUDIO_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY
   */
  static resolveGoogle(input?: {
    env?: Record<string, string | undefined>;
    vaultApiKey?: string;
    vaultCustomFields?: Record<string, unknown>;
  }): GoogleProviderConfig {
    const env = input?.env ?? process.env;

    // 1. Vault credential (highest precedence)
    if (input?.vaultApiKey?.trim()) {
      const apiKey = input.vaultApiKey.trim();
      const custom = input?.vaultCustomFields ?? {};
      const omniModel = typeof custom.omniModel === "string" && custom.omniModel.trim()
        ? custom.omniModel.trim()
        : "gemini-omni-1.1-flash";
      const imageModel = typeof custom.imageModel === "string" && custom.imageModel.trim()
        ? custom.imageModel.trim()
        : "gemini-nano-banana-2.1";

      return {
        apiKey,
        omniModel,
        imageModel,
        imageBatchModel: "gemini-3.1-flash-lite-image",
        imagePremiumModel: "gemini-3-pro-image",
        source: "workspace_vault",
        keyFingerprint: maskSecret(apiKey),
        isConfigured: true,
      };
    }

    // 2. Canonical Environment Key and Aliases
    const apiKey =
      env.MERIDIAN_GEMINI_API_KEY?.trim() ||
      env.GOOGLE_AI_STUDIO_API_KEY?.trim() ||
      env.GEMINI_API_KEY?.trim() ||
      env.GOOGLE_API_KEY?.trim() ||
      undefined;

    // 3. Models
    const omniModel =
      env.MERIDIAN_GEMINI_OMNI_MODEL?.trim() ||
      env.MERIDIAN_OMNI_MODEL?.trim() ||
      "gemini-omni-1.1-flash";

    const imageModel =
      env.MERIDIAN_IMAGE_MODEL?.trim() ||
      env.GOOGLE_NANO_BANANA_MODEL?.trim() ||
      "gemini-nano-banana-2.1";

    return {
      apiKey,
      omniModel,
      imageModel,
      imageBatchModel: "gemini-3.1-flash-lite-image",
      imagePremiumModel: "gemini-3-pro-image",
      source: apiKey ? "environment" : "default",
      keyFingerprint: maskSecret(apiKey),
      isConfigured: Boolean(apiKey),
    };
  }

  /**
   * Resolves Higgsfield credentials and model.
   */
  static resolveHiggsfield(input?: {
    env?: Record<string, string | undefined>;
    vaultApiKey?: string;
    vaultCustomFields?: Record<string, unknown>;
  }): { apiKey?: string; model: string; keyFingerprint?: string; isConfigured: boolean } {
    const env = input?.env ?? process.env;
    const apiKey = input?.vaultApiKey?.trim() || env.HIGGSFIELD_API_KEY?.trim() || undefined;
    const model =
      (typeof input?.vaultCustomFields?.model === "string" ? input.vaultCustomFields.model.trim() : undefined) ||
      env.HIGGSFIELD_MODEL?.trim() ||
      "higgsfield-video-v1";

    return {
      apiKey,
      model,
      keyFingerprint: maskSecret(apiKey),
      isConfigured: Boolean(apiKey),
    };
  }
}
