import { embedExternal, type ExternalSemanticEnv } from "./external.ts";
import { SEMANTIC_MODEL, semanticEmbedBatch } from "./semantic.ts";
import { testEmbedding, type EmbeddingVector } from "./provider.ts";
import type { Transport } from "../providers/http.ts";

/** Provider ids the product can select. Domain code asks for an id. It does not import a vendor SDK. */
export const EMBEDDING_PROVIDER_IDS = ["test:embedding", "local:semantic", "external:semantic"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDER_IDS)[number];

/**
 * test:embedding is off unless a test passes allowTest.
 * local:semantic is MiniLM.
 * external:semantic calls the configured HTTP embeddings API and stores nothing on failure.
 */
export async function embedWithProvider(
  provider: EmbeddingProviderId,
  texts: string[],
  options?: { allowTest?: boolean; transport?: Transport; env?: ExternalSemanticEnv },
): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];
  if (provider === "test:embedding") {
    if (options?.allowTest !== true) throw new Error("test:embedding is off unless a test explicitly allows it.");
    return texts.map((text) => {
      const vector = testEmbedding(text);
      return { ...vector, provider: "test:embedding", model: "test-only" };
    });
  }
  if (provider === "external:semantic") {
    return embedExternal(texts, { transport: options?.transport, env: options?.env });
  }
  const vectors = await semanticEmbedBatch(texts);
  return vectors.map((vector) => ({
    ...vector,
    provider: "local:semantic",
    model: SEMANTIC_MODEL,
    kind: "semantic" as const,
  }));
}
