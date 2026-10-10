/**
 * Unified JEV Runtime Configuration
 *
 * Provides a single, canonical, Zod-validated server-side configuration resolver
 * for TypeSafe Direct and OpenRouter JEV providers, with backward-compatible alias resolution.
 */

import { z } from "zod";
import type { JevRoutingMode, JevProviderId } from "./types.ts";

export const jevRuntimeConfigSchema = z.object({
  mode: z.enum(["auto", "typesafe_direct", "openrouter", "compare"]).default("auto"),
  preferredProvider: z.enum(["typesafe_direct", "openrouter"]).default("typesafe_direct"),
  // Off unless explicitly enabled: a decision never silently moves to another paid transport.
  fallbackEnabled: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30000),
  compareSampleRate: z.number().min(0).max(1).default(0.1),

  // TypeSafe Direct Configuration
  typesafe: z.object({
    apiKey: z.string().default(""),
    baseUrl: z.string().url().default("https://api.typesafe.ai/v1/systemone"),
    model: z.string().default("typesafe/jev-1.13"),
  }),

  // OpenRouter Decisions Configuration
  openrouter: z.object({
    apiKey: z.string().default(""),
    baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
    model: z.string().default("typesafe/jev-1.13"),
  }),
});

export type JevRuntimeConfig = z.infer<typeof jevRuntimeConfigSchema>;

/**
 * Normalizes provider mode string to canonical enum value.
 */
function normalizeMode(raw?: string): JevRoutingMode {
  if (!raw) return "auto";
  const lower = raw.trim().toLowerCase();
  if (lower === "typesafe" || lower === "typesafe_direct") return "typesafe_direct";
  if (lower === "openrouter") return "openrouter";
  if (lower === "compare") return "compare";
  return "auto";
}

/**
 * Normalizes provider id string to canonical enum value.
 */
function normalizeProviderId(raw?: string): JevProviderId {
  if (!raw) return "typesafe_direct";
  const lower = raw.trim().toLowerCase();
  if (lower === "typesafe" || lower === "typesafe_direct") return "typesafe_direct";
  if (lower === "openrouter") return "openrouter";
  return "typesafe_direct";
}

/**
 * Resolves JEV runtime configuration from environment variables and explicit overrides.
 */
export function resolveJevConfig(overrides?: Partial<JevRuntimeConfig>): JevRuntimeConfig {
  const env = process.env;

  const rawMode = overrides?.mode ?? env.MERIDIAN_JEV_PROVIDER_MODE ?? env.JEV_PROVIDER_MODE ?? env.JEV_MODE;
  const mode = normalizeMode(rawMode);

  const rawPreferred = overrides?.preferredProvider ?? env.MERIDIAN_JEV_PREFERRED_PROVIDER ?? env.JEV_PREFERRED_PROVIDER;
  const preferredProvider = normalizeProviderId(rawPreferred);

  const rawFallback = overrides?.fallbackEnabled ?? env.MERIDIAN_JEV_FALLBACK_ENABLED ?? env.JEV_FALLBACK_ENABLED;
  const fallbackEnabled = rawFallback !== undefined ? String(rawFallback).toLowerCase() === "true" : false;

  const timeoutMs = overrides?.timeoutMs ?? (env.MERIDIAN_JEV_TIMEOUT_MS ? parseInt(env.MERIDIAN_JEV_TIMEOUT_MS, 10) : 30000);
  const compareSampleRate = overrides?.compareSampleRate ?? (env.MERIDIAN_JEV_COMPARE_SAMPLE_RATE ? parseFloat(env.MERIDIAN_JEV_COMPARE_SAMPLE_RATE) : 0.1);

  // TypeSafe Direct: canonical TYPESAFE_JEV_*, with fallback to TYPESAFE_*
  const typesafeApiKey = overrides?.typesafe?.apiKey ?? env.TYPESAFE_JEV_API_KEY?.trim() ?? env.TYPESAFE_API_KEY?.trim() ?? "";
  const typesafeBaseUrl = overrides?.typesafe?.baseUrl ?? env.TYPESAFE_JEV_BASE_URL?.trim() ?? env.TYPESAFE_BASE_URL?.trim() ?? "https://api.typesafe.ai/v1/systemone";
  const typesafeModel = overrides?.typesafe?.model ?? env.TYPESAFE_JEV_MODEL?.trim() ?? env.TYPESAFE_MODEL?.trim() ?? "typesafe/jev-1.13";

  // OpenRouter: canonical OPENROUTER_JEV_*, with fallback to OPENROUTER_* / JEV_*
  const openrouterApiKey = overrides?.openrouter?.apiKey ?? env.OPENROUTER_JEV_API_KEY?.trim() ?? env.OPENROUTER_API_KEY?.trim() ?? "";
  const openrouterBaseUrl = overrides?.openrouter?.baseUrl ?? env.OPENROUTER_JEV_BASE_URL?.trim() ?? env.JEV_BASE_URL?.trim() ?? "https://openrouter.ai/api/v1";
  const openrouterModel = overrides?.openrouter?.model ?? env.OPENROUTER_JEV_MODEL?.trim() ?? env.OPENROUTER_MODEL?.trim() ?? env.JEV_MODEL?.trim() ?? "typesafe/jev-1.13";

  return jevRuntimeConfigSchema.parse({
    mode,
    preferredProvider,
    fallbackEnabled,
    timeoutMs,
    compareSampleRate,
    typesafe: {
      apiKey: typesafeApiKey,
      baseUrl: typesafeBaseUrl,
      model: typesafeModel,
    },
    openrouter: {
      apiKey: openrouterApiKey,
      baseUrl: openrouterBaseUrl,
      model: openrouterModel,
    },
  });
}
