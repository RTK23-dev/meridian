// Asset specs, the provider adapter interface and provider errors (Bible sections 10.1 and 10.4).

import { z } from "zod";
import { contentHash } from "./hash.ts";
import { idSchema } from "./ids.ts";
import { EngineError } from "./errors.ts";
import { modelClassSchema, type ModelClass } from "./plan.ts";
import { positiveMsSchema } from "./primitives.ts";

/** The sources of a model choice (Bible 10.5 step 2): the orchestrator's pick, or the route table's first eligible fallback. */
/** Who chose the model: the orchestrator, the fallback list, or the reviewer for one remake (D11, the reviewer's pick is priced like any other). */
export const MODEL_CHOICE_SOURCES = ["orchestrator", "fallback", "reviewer"] as const;
export const modelChoiceSourceSchema = z.enum(MODEL_CHOICE_SOURCES);
export type ModelChoiceSource = z.infer<typeof modelChoiceSourceSchema>;

/** The longest reason a model choice carries, in characters (contract v7). */
export const MODEL_CHOICE_REASON_MAX = 500;

/**
 * The model the orchestrator chose for one paid call (Bible 10.5, contract v7). The provider is always OpenRouter. `modelId`
 * is an id of the catalog candidates the director was given; code checks that, the schema only checks its shape.
 */
export const modelChoiceSchema = z.object({
  provider: z.literal("openrouter"),
  modelId: z.string().min(1),
  source: modelChoiceSourceSchema,
  reason: z.string().min(1).max(MODEL_CHOICE_REASON_MAX),
  catalogReadAt: z.iso.datetime(),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

export const assetSpecSchema = z.object({
  schema: z.literal("meridian.asset_spec/v1"),
  specId: idSchema("asp_"),
  shotId: idSchema("shot_"),
  modelClass: modelClassSchema,
  prompt: z.string().min(1),
  refs: z.array(z.string().min(1)),
  firstFrame: z.string().min(1).optional(),
  lastFrame: z.string().min(1).optional(),
  durationMs: positiveMsSchema,
  aspect: z.literal("9:16"),
  width: z.literal(1080),
  height: z.literal(1920),
  seed: z.int().nonnegative().max(0xffffffff),
  takes: z.union([z.literal(1), z.literal(2)]),
  /**
   * The orchestrator's model choice for this call (contract v7). A spec written under v6 has no such key and reads as null:
   * no choice was made, and the route table applies.
   */
  modelChoice: modelChoiceSchema.nullable().default(null),
});
export type AssetSpec = z.infer<typeof assetSpecSchema>;

/** Prompt normal form for cache keys: trimmed, whitespace collapsed, lower-cased (Bible 10.4). */
export function normalisePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Cache key of an asset request (Bible 10.4): sha256 of the canonical JSON of the model class, the normalised
 * prompt, references, first and last frame, duration, seed, number of takes and provider. Absent frames count as null.
 * The take count is part of the key: a two-take request must not be answered from a one-take entry, or the other way round.
 */
export function assetCacheKey(spec: AssetSpec, providerId: string): string {
  if (providerId.length === 0) {
    throw new EngineError("invalid_input", "assetCacheKey needs a provider id");
  }
  return contentHash({
    modelClass: spec.modelClass,
    prompt: normalisePrompt(spec.prompt),
    refs: spec.refs,
    firstFrame: spec.firstFrame ?? null,
    lastFrame: spec.lastFrame ?? null,
    durationMs: spec.durationMs,
    seed: spec.seed,
    takes: spec.takes,
    providerId,
  });
}

export const PROVIDER_ERROR_KINDS = [
  "rate_limit",
  "timeout",
  "invalid_input",
  "content_policy",
  "server",
  "unknown",
] as const;

export const providerErrorSchema = z.object({
  kind: z.enum(PROVIDER_ERROR_KINDS),
  retryable: z.boolean(),
  message: z.string(),
});
export type ProviderError = z.infer<typeof providerErrorSchema>;

export type ProviderCapabilities = {
  maxSeconds: number;
  minSeconds: number;
  firstFrame: boolean;
  lastFrame: boolean;
  refsMax: number;
  audio: boolean;
  aspect: string[];
};

export type ProviderPoll = {
  state: "pending" | "done" | "failed";
  uri?: string;
  error?: ProviderError;
  actualUsd?: number;
};

/**
 * One vendor behind the asset router (Bible 10.1). price() must throw a typed EngineError when the
 * price is unknown; it never returns 0 for an unknown price. submit() receives the idempotency key.
 */
export interface ProviderAdapter {
  id: string;
  modelClass: ModelClass;
  capabilities: ProviderCapabilities;
  price(spec: AssetSpec): { estimateUsd: number };
  submit(spec: AssetSpec, key: string): Promise<{ jobRef: string }>;
  poll(jobRef: string): Promise<ProviderPoll>;
  cancel?(jobRef: string): Promise<void>;
}
