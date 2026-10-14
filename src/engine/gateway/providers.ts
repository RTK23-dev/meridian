// The providers the gateway can reach. Switching a capability to another provider is a change to config/routes.ts; adding a
// provider is one entry here plus, when it needs a key, one credential id the credential source knows.

import type { ProviderSpec } from "./types.ts";

export const PROVIDER_IDS = ["openrouter", "anthropic", "heygen", "media_functions"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderRegistry = Record<ProviderId, ProviderSpec>;

export const DEFAULT_PROVIDERS: ProviderRegistry = {
  // The default platform for every model API (owner decision, PHASE_LOG 2026-10-14).
  openrouter: {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { kind: "api_key", header: "Authorization", scheme: "Bearer" },
    credentialId: "openrouter",
    defaultHeaders: { "X-Title": "Meridian" },
  },
  // Kept so a route can move Claude back to the Anthropic API directly. Meridian has no Anthropic credential yet, so it is
  // not connected until one exists.
  anthropic: {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: { kind: "api_key", header: "x-api-key", scheme: null },
    credentialId: "anthropic",
    defaultHeaders: { "anthropic-version": "2023-06-01" },
  },
  // HyperFrames cloud rendering. The render adapter adds its own key header from gateway.secretFor("heygen").
  heygen: {
    id: "heygen",
    baseUrl: "https://api.heygen.com",
    auth: { kind: "api_key", header: "x-api-key", scheme: null },
    credentialId: "heygen",
    defaultHeaders: {},
  },
  // The serverless ffmpeg functions. The deployment sets the base URL; until then they are not connected.
  media_functions: {
    id: "media_functions",
    baseUrl: null,
    auth: { kind: "none" },
    credentialId: null,
    defaultHeaders: {},
  },
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
