import { cosineSimilarity, type EmbeddingVector } from "./provider.ts";
import { embedWithProvider } from "./select.ts";
import { clusterFingerprints, type MarketCluster } from "../intelligence/whitespace.ts";
import type { Sql } from "../learning/store.ts";

const PROVIDER = "local:semantic";

type CreativeRow = {
  id: string;
  origin: string;
  angle: string;
  text: string;
};

type StoredVector = CreativeRow & { vector: EmbeddingVector };

function parseVector(row: { creative_id: string; vector: string; dimensions: number }, creative: CreativeRow): StoredVector | null {
  let values: number[] = [];
  try {
    const parsed = JSON.parse(row.vector) as unknown;
    if (!Array.isArray(parsed)) return null;
    values = parsed.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  } catch {
    return null;
  }
  if (values.length < 8 || values.length !== Number(row.dimensions)) return null;
  return {
    ...creative,
    vector: {
      provider: PROVIDER,
      model: "Xenova/all-MiniLM-L6-v2",
      kind: "semantic",
      dimensions: values.length,
      values,
    },
  };
}

async function readVectors(sql: Sql, organizationId: string, brandId: string, creatives: CreativeRow[]): Promise<StoredVector[]> {
  const rows = await sql<{ creative_id: string; vector: string; dimensions: number }>`
    select creative_id, vector, dimensions from creative_embeddings
    where brand_id = ${brandId} and organization_id = ${organizationId} and provider = ${PROVIDER}
  `;
  const byId = new Map(creatives.map((creative) => [creative.id, creative]));
  const stored: StoredVector[] = [];
  for (const row of rows) {
    const creative = byId.get(row.creative_id);
    if (!creative) continue;
    const parsed = parseVector(row, creative);
    if (parsed) stored.push(parsed);
  }
  return stored;
}

/** Reads stored local:semantic vectors and clusters them. Does not invent vectors. */
export async function readSemanticClusters(
  sql: Sql,
  organizationId: string,
  brandId: string,
  creatives: CreativeRow[],
): Promise<{ clusters: MarketCluster[]; stored: number; note: string }> {
  const stored = await readVectors(sql, organizationId, brandId, creatives);
  if (stored.length === 0) {
    return {
      clusters: [],
      stored: 0,
      note: "No local:semantic vectors are stored. Angle counts are fingerprints, not semantic clusters.",
    };
  }
  const clusters = clusterFingerprints(
    stored.map((item) => ({ id: item.id, origin: item.origin, angle: item.angle, vector: item.vector })),
  );
  return {
    clusters,
    stored: stored.length,
    note: `${stored.length} creatives have local:semantic vectors. Clusters use those vectors, not token overlap.`,
  };
}

/** Embeds creatives that do not yet have a local:semantic row, then clusters. A model failure stores nothing. */
export async function ensureLocalSemantic(
  sql: Sql,
  organizationId: string,
  brandId: string,
  creatives: CreativeRow[],
): Promise<{ clusters: MarketCluster[]; stored: number; note: string }> {
  const existing = await readVectors(sql, organizationId, brandId, creatives);
  const have = new Set(existing.map((item) => item.id));
  const missing = creatives
    .filter((creative) => creative.text.trim().length >= 8 && !have.has(creative.id))
    .slice(0, 16);
  if (missing.length > 0) {
    const vectors = await embedWithProvider(PROVIDER, missing.map((creative) => creative.text.slice(0, 800)));
    for (let index = 0; index < missing.length; index += 1) {
      const creative = missing[index];
      const vector = vectors[index];
      if (!creative || !vector) continue;
      await sql`
        insert into creative_embeddings (
          id, organization_id, brand_id, creative_id, provider, model, dimensions, vector
        ) values (
          ${`${creative.id}:${PROVIDER}`}, ${organizationId}, ${brandId}, ${creative.id},
          ${PROVIDER}, ${vector.model}, ${vector.dimensions}, ${JSON.stringify(vector.values)}
        )
        on conflict (creative_id, provider, model) do update set vector = excluded.vector, dimensions = excluded.dimensions
      `;
    }
  }
  return readSemanticClusters(sql, organizationId, brandId, creatives);
}

/** Cosine to the nearest other text. Null when the model does not return vectors. Token overlap is not a substitute. */
export async function semanticNearest(copy: string, others: string[]): Promise<number | null> {
  const rest = others.map((text) => text.trim()).filter((text) => text.length >= 8).slice(0, 6);
  if (copy.trim().length < 8 || rest.length === 0) return null;
  const vectors = await embedWithProvider(PROVIDER, [copy.slice(0, 800), ...rest.map((text) => text.slice(0, 800))]);
  const query = vectors[0];
  if (!query) return null;
  let best = 0;
  for (const vector of vectors.slice(1)) {
    best = Math.max(best, cosineSimilarity(query.values, vector.values));
  }
  return best;
}
