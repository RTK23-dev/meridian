import type { Transport } from "../providers/http.ts";
import { liveTransport, sendWithRetry } from "../providers/http.ts";
import type { EmbeddingVector } from "./provider.ts";

export type ExternalSemanticEnv = {
  url?: string;
  key?: string;
  model?: string;
  dimensions?: number;
};

function envFromProcess(): ExternalSemanticEnv {
  const dimensions = Number(process.env.EXTERNAL_SEMANTIC_DIMENSIONS ?? "");
  return {
    url: process.env.EXTERNAL_SEMANTIC_URL,
    key: process.env.EXTERNAL_SEMANTIC_KEY,
    model: process.env.EXTERNAL_SEMANTIC_MODEL,
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : undefined,
  };
}

/**
 * OpenAI-compatible embeddings HTTP API.
 * A failed or invalid response throws. Nothing is replaced with a lexical hash.
 */
export async function embedExternal(
  texts: string[],
  options?: { env?: ExternalSemanticEnv; transport?: Transport },
): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];
  const env = options?.env ?? envFromProcess();
  const url = env.url?.trim() ?? "";
  const key = env.key?.trim() ?? "";
  const model = env.model?.trim() || "text-embedding-3-small";
  if (!url || !key) {
    throw new Error("external:semantic is not connected. No vector was stored.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error("external:semantic URL is invalid. No vector was stored.");
  }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
    throw new Error("external:semantic requires https. No vector was stored.");
  }
  const transport = options?.transport ?? liveTransport();
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: endpoint.toString(),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: texts.map((text) => text.slice(0, 8000)) }),
  });
  if (!result.ok) {
    throw new Error(`external:semantic failed (${result.status || "network"}). No vector was stored.`);
  }
  const body = result.json;
  const data = body && typeof body === "object" && "data" in body ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("external:semantic returned an unexpected payload. No vector was stored.");
  }
  const vectors: EmbeddingVector[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const row = data.find((item) => item && typeof item === "object" && (item as { index?: unknown }).index === index) ?? data[index];
    const embedding = row && typeof row === "object" ? (row as { embedding?: unknown }).embedding : null;
    if (!Array.isArray(embedding) || embedding.length < 8 || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("external:semantic returned a vector that failed validation. No vector was stored.");
    }
    if (env.dimensions && embedding.length !== env.dimensions) {
      throw new Error(`external:semantic returned ${embedding.length} dimensions, expected ${env.dimensions}. No vector was stored.`);
    }
    vectors.push({
      provider: "external:semantic",
      model,
      kind: "semantic",
      dimensions: embedding.length,
      values: embedding,
    });
  }
  return vectors;
}
