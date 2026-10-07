import type { Sql } from "../learning/store.ts";
import { cosineSimilarity } from "../embeddings/provider.ts";

export type ConceptAd = {
  id: string;
  concept: string;
  advertiser: string;
  week: string;
  niche: string;
  embedding?: number[] | null;
};

export type EmbeddingAdItem = {
  id: string;
  researchAdId: string;
  advertiser: string;
  capturedAt: string;
  niche: string;
  conceptLabel: string;
  embedding: number[];
};

export type ConceptCluster = {
  concept: string;
  seedAngle?: string;
  adIds: string[];
  centroid: number[];
  ads: ConceptAd[];
};

export type ConceptMomentum = "rising" | "peaking" | "fading" | "stable";

export type ConceptTrend = {
  concept: string;
  adsThisWeek: number;
  adsPrevWeek: number;
  newAdvertisers: number;
  momentum: ConceptMomentum;
  saturation: number;
  whitespace: boolean;
  evidence: string[];
};

function weekKey(value: string): string {
  return value.trim().slice(0, 10);
}

/**
 * Literal concept grouping (backward compatibility).
 */
export function clusterConcepts(ads: ConceptAd[]): Map<string, ConceptAd[]> {
  const groups = new Map<string, ConceptAd[]>();
  for (const ad of ads) {
    const concept = ad.concept.trim().toLowerCase();
    if (!concept) continue;
    const list = groups.get(concept) ?? [];
    list.push(ad);
    groups.set(concept, list);
  }
  return groups;
}

/**
 * Cluster ads using Step 2 pgvector embeddings (cosine similarity >= threshold).
 * Forms data-driven concepts beyond fixed angles.
 */
export function clusterAdsByEmbeddings(
  ads: EmbeddingAdItem[],
  options: { minSimilarity?: number } = {},
): ConceptCluster[] {
  const threshold = options.minSimilarity ?? 0.82;
  const clusters: ConceptCluster[] = [];

  for (const ad of ads) {
    if (!ad.embedding || ad.embedding.length === 0) continue;

    let bestCluster: ConceptCluster | null = null;
    let bestSimilarity = -1;

    for (const cluster of clusters) {
      const sim = cosineSimilarity(ad.embedding, cluster.centroid);
      if (sim >= threshold && sim > bestSimilarity) {
        bestSimilarity = sim;
        bestCluster = cluster;
      }
    }

    const conceptAd: ConceptAd = {
      id: ad.id,
      concept: ad.conceptLabel,
      advertiser: ad.advertiser,
      week: ad.capturedAt,
      niche: ad.niche,
      embedding: ad.embedding,
    };

    if (bestCluster) {
      bestCluster.adIds.push(ad.id);
      bestCluster.ads.push(conceptAd);
      // Update running centroid
      const n = bestCluster.ads.length;
      bestCluster.centroid = bestCluster.centroid.map((val, idx) => (val * (n - 1) + (ad.embedding[idx] ?? 0)) / n);
    } else {
      clusters.push({
        concept: ad.conceptLabel,
        adIds: [ad.id],
        centroid: [...ad.embedding],
        ads: [conceptAd],
      });
    }
  }

  return clusters;
}

/**
 * Real week-over-week trend engine:
 * Computes momentum (rising, peaking, fading) strictly from actual
 * week-over-week counts and advertiser counts. Zero invented metrics.
 */
export function trendReport(input: {
  ads: ConceptAd[];
  thisWeek: string;
  prevWeek: string;
  brandConcepts: string[];
}): ConceptTrend[] {
  const groups = clusterConcepts(input.ads);
  const brand = new Set(input.brandConcepts.map((item) => item.trim().toLowerCase()).filter(Boolean));
  const thisWeek = weekKey(input.thisWeek);
  const prevWeek = weekKey(input.prevWeek);
  const trends: ConceptTrend[] = [];

  for (const [concept, rows] of groups) {
    const current = rows.filter((row) => weekKey(row.week) === thisWeek);
    const previous = rows.filter((row) => weekKey(row.week) === prevWeek);
    const advertisersNow = new Set(current.map((row) => row.advertiser));
    const advertisersPrev = new Set(previous.map((row) => row.advertiser));
    const newAdvertisers = [...advertisersNow].filter((name) => !advertisersPrev.has(name)).length;
    const adsThisWeek = current.length;
    const adsPrevWeek = previous.length;
    const ratio = adsPrevWeek === 0 ? (adsThisWeek > 0 ? 2 : 1) : adsThisWeek / adsPrevWeek;

    let momentum: ConceptMomentum = "stable";
    if (adsThisWeek === 0 && adsPrevWeek > 0) {
      momentum = "fading";
    } else if (ratio >= 1.4 && newAdvertisers > 0) {
      momentum = "rising";
    } else if (ratio <= 0.7) {
      momentum = "fading";
    } else if (adsThisWeek >= 6 && ratio < 1.15 && ratio > 0.85) {
      momentum = "peaking";
    }

    const saturation = Math.min(1, advertisersNow.size / 8);
    trends.push({
      concept,
      adsThisWeek,
      adsPrevWeek,
      newAdvertisers,
      momentum,
      saturation,
      whitespace: !brand.has(concept) && adsThisWeek > 0,
      evidence: [
        `${adsThisWeek} ads this week vs ${adsPrevWeek} last week`,
        `${newAdvertisers} new advertisers`,
        `${advertisersNow.size} advertisers in-niche`,
      ],
    });
  }

  return trends.sort((a, b) => b.adsThisWeek - a.adsThisWeek || a.concept.localeCompare(b.concept));
}

/**
 * Cluster Creative DNA rows stored in database using Step 2 pgvector embeddings.
 */
export async function clusterStoredCreativeDna(
  sql: Sql,
  input: { organizationId: string; brandId: string; minSimilarity?: number },
): Promise<ConceptCluster[]> {
  const rows = await sql<{
    id: string;
    research_ad_id: string;
    record: string;
    embedding_str: string;
    advertiser: string;
    captured_at: string;
    niche: string;
  }>`
    select
      d.id,
      d.research_ad_id,
      d.record,
      d.embedding::text as embedding_str,
      coalesce(a.advertiser, 'Unknown') as advertiser,
      coalesce(a.captured_at::text, d.created_at::text) as captured_at,
      coalesce(r.niche, '') as niche
    from creative_dna d
    left join research_ads a on a.id = d.research_ad_id and a.organization_id = d.organization_id and a.brand_id = d.brand_id
    left join factory_runs r on r.organization_id = d.organization_id and r.brand_id = d.brand_id
    where d.organization_id = ${input.organizationId} and d.brand_id = ${input.brandId}
      and d.embedding is not null
  `;

  const items: EmbeddingAdItem[] = [];
  for (const row of rows) {
    let emb: number[] = [];
    try {
      if (row.embedding_str) {
        emb = JSON.parse(row.embedding_str);
      }
    } catch {
      continue;
    }
    if (emb.length === 0) continue;

    let conceptLabel = "creative concept";
    try {
      const record = JSON.parse(row.record) as {
        format?: { value?: string };
        hook?: { type?: { value?: string } };
        angle?: { value?: string };
      };
      const parts = [
        record.format?.value !== "other" ? record.format?.value : "",
        record.hook?.type?.value ? `${record.hook.type.value} hook` : "",
        record.angle?.value || "",
      ].filter(Boolean);
      if (parts.length > 0) conceptLabel = parts.join(" ");
    } catch {
      // keep fallback label
    }

    items.push({
      id: row.id,
      researchAdId: row.research_ad_id,
      advertiser: row.advertiser,
      capturedAt: row.captured_at,
      niche: row.niche,
      conceptLabel,
      embedding: emb,
    });
  }

  return clusterAdsByEmbeddings(items, { minSimilarity: input.minSimilarity });
}

export function risingKeptRising(history: { week: string; rising: string[] }[]): number | null {
  if (history.length < 3) return null;
  const first = history[0]!;
  if (first.rising.length === 0) return null;
  const later = history.slice(1);
  let kept = 0;
  for (const concept of first.rising) {
    if (later.every((week) => week.rising.includes(concept))) kept += 1;
  }
  return Math.round((kept / first.rising.length) * 1000) / 1000;
}
