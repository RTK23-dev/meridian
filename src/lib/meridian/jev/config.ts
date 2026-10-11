/**
 * JEV runtime configuration. The decision transport is TypeSafe Direct only. One engine serves a workspace, so there is no
 * routing mode, no second transport and no fallback between transports: a decision never pays for another provider.
 */

import { z } from "zod";

export const jevRuntimeConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(30000),

  // The key is not runtime config. It is resolved per organization by credentials/resolve.ts.
  typesafe: z.object({
    baseUrl: z.string().url().default("https://api.typesafe.ai/v1/systemone"),
    model: z.string().default("typesafe/jev-1.13"),
  }),
});

export type JevRuntimeConfig = z.infer<typeof jevRuntimeConfigSchema>;

/** Resolves JEV runtime configuration from environment variables and explicit overrides. */
export function resolveJevConfig(overrides?: Partial<JevRuntimeConfig>): JevRuntimeConfig {
  const env = process.env;

  const timeoutMs = overrides?.timeoutMs ?? (env.MERIDIAN_JEV_TIMEOUT_MS ? parseInt(env.MERIDIAN_JEV_TIMEOUT_MS, 10) : 30000);

  // TypeSafe Direct: canonical TYPESAFE_JEV_*, with fallback to TYPESAFE_*
  const typesafeBaseUrl = overrides?.typesafe?.baseUrl ?? env.TYPESAFE_JEV_BASE_URL?.trim() ?? env.TYPESAFE_BASE_URL?.trim() ?? "https://api.typesafe.ai/v1/systemone";
  const typesafeModel = overrides?.typesafe?.model ?? env.TYPESAFE_JEV_MODEL?.trim() ?? env.TYPESAFE_MODEL?.trim() ?? "typesafe/jev-1.13";

  return jevRuntimeConfigSchema.parse({
    timeoutMs,
    typesafe: {
      baseUrl: typesafeBaseUrl,
      model: typesafeModel,
    },
  });
}
