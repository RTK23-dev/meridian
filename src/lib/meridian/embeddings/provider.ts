export type EmbeddingKind = "semantic" | "lexical" | "test";

export type EmbeddingVector = {
  provider: string;
  model: string;
  kind: EmbeddingKind;
  dimensions: number;
  values: number[];
};

/**
 * Explicit test provider. Production code must not present these vectors as a semantic model.
 */
export function testEmbedding(text: string): EmbeddingVector {
  const values = new Array<number>(8).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
  tokens.forEach((token, index) => {
    values[index % values.length] += token.length;
  });
  const norm = Math.hypot(...values) || 1;
  return {
    provider: "test-embedding",
    model: "test-only",
    kind: "test",
    dimensions: values.length,
    values: values.map((value) => value / norm),
  };
}

/**
 * The external embeddings API is connected when EXTERNAL_SEMANTIC_URL and EXTERNAL_SEMANTIC_KEY are set. Those are the
 * variables embedExternal reads, so this check and the calls agree. OPENROUTER_API_KEY is not an embeddings setting.
 */
export function embeddingProviderState(env: { url?: string; key?: string }): {
  status: "NOT_CONNECTED" | "CONFIGURED";
  provider: string;
  detail: string;
} {
  if (!env.url?.trim() || !env.key?.trim()) {
    return {
      status: "NOT_CONNECTED",
      provider: "",
      detail: "No external embeddings API is connected. Lexical hashing remains available and is not a semantic embedding.",
    };
  }
  return {
    status: "CONFIGURED",
    provider: "external:semantic",
    detail: "EXTERNAL_SEMANTIC_URL and EXTERNAL_SEMANTIC_KEY are set. Vectors are stored only after the embeddings API returns them. A rejected call stores no vector.",
  };
}

export function localSemanticModel(): {
  status: "AVAILABLE";
  provider: "local-minilm";
  model: "Xenova/all-MiniLM-L6-v2";
  kind: "SEMANTIC_EMBEDDING";
  detail: string;
} {
  return {
    status: "AVAILABLE",
    provider: "local-minilm",
    model: "Xenova/all-MiniLM-L6-v2",
    kind: "SEMANTIC_EMBEDDING",
    detail:
      "Local MiniLM returns semantic vectors when a call succeeds. Lexical hashing is a separate mechanism and is never stored as this model. If the model fails, no hash is substituted.",
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export type VectorHit = {
  id: string;
  brandId: string;
  score: number;
};

/** Other brands are omitted. Weak scores are omitted. This does not create vectors. */
export function retrieveSimilar(
  query: EmbeddingVector,
  corpus: { id: string; brandId: string; vector: EmbeddingVector }[],
  brandId: string,
  limit = 5,
  minScore = 0.35,
): VectorHit[] {
  if (query.kind === "lexical") {
    throw new Error("Lexical hashes are not semantic embeddings.");
  }
  return corpus
    .filter((item) => item.brandId === brandId && item.vector.kind === query.kind && item.vector.provider === query.provider)
    .map((item) => ({ id: item.id, brandId: item.brandId, score: cosineSimilarity(query.values, item.vector.values) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
