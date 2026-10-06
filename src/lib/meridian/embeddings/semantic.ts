import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { cosineSimilarity, retrieveSimilar, type EmbeddingVector, type VectorHit } from "./provider.ts";

export const SEMANTIC_MODEL = "Xenova/all-MiniLM-L6-v2";
export const SEMANTIC_PROVIDER = "local-minilm";

const cache = new Map<string, EmbeddingVector>();
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function cacheDir(): string {
  if (process.env.HF_HOME?.trim()) return process.env.HF_HOME.trim();
  return join(tmpdir(), "meridian-hf");
}

async function extractor(): Promise<FeatureExtractionPipeline> {
  env.cacheDir = cacheDir();
  extractorPromise ??= pipeline("feature-extraction", SEMANTIC_MODEL, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
  return extractorPromise;
}

function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function vectorFrom(data: ArrayLike<number>, offset: number, dimensions: number): EmbeddingVector {
  const values: number[] = [];
  for (let index = 0; index < dimensions; index += 1) values.push(Number(data[offset + index] ?? 0));
  return {
    provider: SEMANTIC_PROVIDER,
    model: SEMANTIC_MODEL,
    kind: "semantic",
    dimensions,
    values,
  };
}

/**
 * Real local semantic vectors. A failure throws.
 * This function never substitutes a lexical hash.
 */
export async function semanticEmbed(text: string): Promise<EmbeddingVector> {
  const [vector] = await semanticEmbedBatch([text]);
  if (!vector) throw new Error("The embedding model returned no vector.");
  return vector;
}

export async function semanticEmbedBatch(texts: string[]): Promise<EmbeddingVector[]> {
  const trimmed = texts.map((text) => text.trim());
  if (trimmed.some((text) => text.length === 0)) throw new Error("Cannot embed empty text.");
  const pending: number[] = [];
  const results: EmbeddingVector[] = new Array(trimmed.length);
  trimmed.forEach((text, index) => {
    const hit = cache.get(cacheKey(text));
    if (hit) results[index] = hit;
    else pending.push(index);
  });
  if (pending.length === 0) return results;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const model = await extractor();
      const output = await model(pending.map((index) => trimmed[index] as string), { pooling: "mean", normalize: true });
      const dims = output.dims;
      const width = dims[dims.length - 1] ?? 0;
      if (width < 8) throw new Error("The embedding model returned a vector that is too small to be semantic.");
      const data = output.data;
      pending.forEach((source, row) => {
        const vector = vectorFrom(data, row * width, width);
        const text = trimmed[source] as string;
        cache.set(cacheKey(text), vector);
        results[source] = vector;
      });
      return results;
    } catch (error) {
      lastError = error;
      extractorPromise = null;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Semantic embedding failed.");
}

export type SemanticItem = {
  id: string;
  brandId: string;
  organizationId?: string;
  vector: EmbeddingVector;
  metadata?: Record<string, string>;
};

/** Tenant and metadata filters run before cosine. Lexical vectors are refused by retrieveSimilar. */
export function semanticSearch(
  query: EmbeddingVector,
  corpus: SemanticItem[],
  options: { brandId: string; organizationId?: string; limit?: number; minScore?: number; metadata?: Record<string, string> },
): VectorHit[] {
  if (query.kind !== "semantic") throw new Error("Semantic retrieval requires a SEMANTIC_EMBEDDING vector.");
  const filtered = corpus.filter((item) => {
    if (options.organizationId && item.organizationId && item.organizationId !== options.organizationId) return false;
    if (!options.metadata) return true;
    return Object.entries(options.metadata).every(([key, value]) => item.metadata?.[key] === value);
  });
  return retrieveSimilar(query, filtered, options.brandId, options.limit ?? 5, options.minScore ?? 0.2);
}

export { cosineSimilarity };
