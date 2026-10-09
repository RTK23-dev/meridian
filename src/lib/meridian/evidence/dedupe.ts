/**
 * Universal Evidence Deduplication
 *
 * Implements 5-layer idempotent deduplication:
 * 1. Canonical URL match
 * 2. Platform external ID match
 * 3. SHA-256 media content hash match
 * 4. Perceptual hash (pHash) Hamming distance threshold
 * 5. Semantic embedding cosine similarity threshold
 */


export type DedupeCandidate = {
  id: string;
  canonicalUrl?: string | null;
  externalId?: string | null;
  platform?: string | null;
  sha256?: string | null;
  pHash?: string | null;
  embedding?: number[] | null;
};

export type DedupeMatchResult = {
  isDuplicate: boolean;
  matchLayer?: "canonical_url" | "external_id" | "media_sha256" | "perceptual_hash" | "embedding_similarity";
  matchedId?: string;
  confidence: number;
};

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "dclid", "msclkid", "igshid", "igsh", "si", "mc_cid", "mc_eid", "ref_src", "ref_url"]);
const DEFAULT_PORTS = new Set(["80", "443"]);

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/**
 * Canonical form of a URL for identity, not for display. Query parameters that name the resource
 * (such as `?id=`) are kept: two products on one path are two sources. Tracking parameters, the
 * fragment, the scheme (http and https serve the same page here), default ports, and trailing
 * slashes are removed. `www.` and path case are kept, because they can name different resources.
 * Input that is not an http(s) URL is returned trimmed and lower-cased, so it can still be compared.
 */
export function normalizeCanonicalUrl(url?: string | null): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return trimmed.toLowerCase();
  const port = parsed.port && !DEFAULT_PORTS.has(parsed.port) ? `:${parsed.port}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  const kept = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([nameA, valueA], [nameB, valueB]) => (nameA === nameB ? compareText(valueA, valueB) : compareText(nameA, nameB)));
  const query = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";
  return `https://${parsed.hostname}${port}${path}${query}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function findDuplicateEvidence(
  incoming: DedupeCandidate,
  existingCorpus: DedupeCandidate[],
  options: {
    maxHammingDistance?: number; // Default: 8
    minCosineSimilarity?: number; // Default: 0.94
  } = {},
): DedupeMatchResult {
  const maxHamming = options.maxHammingDistance ?? 8;
  const minCosine = options.minCosineSimilarity ?? 0.94;

  const normalizedIncomingUrl = normalizeCanonicalUrl(incoming.canonicalUrl);

  for (const existing of existingCorpus) {
    // Layer 1: Canonical URL
    if (normalizedIncomingUrl && existing.canonicalUrl) {
      const normalizedExistingUrl = normalizeCanonicalUrl(existing.canonicalUrl);
      if (normalizedIncomingUrl === normalizedExistingUrl) {
        return {
          isDuplicate: true,
          matchLayer: "canonical_url",
          matchedId: existing.id,
          confidence: 1.0,
        };
      }
    }

    // Layer 2: Platform External ID
    if (
      incoming.externalId &&
      existing.externalId &&
      incoming.platform === existing.platform &&
      incoming.externalId === existing.externalId
    ) {
      return {
        isDuplicate: true,
        matchLayer: "external_id",
        matchedId: existing.id,
        confidence: 1.0,
      };
    }

    // Layer 3: SHA-256 Media Hash
    if (incoming.sha256 && existing.sha256 && incoming.sha256 === existing.sha256) {
      return {
        isDuplicate: true,
        matchLayer: "media_sha256",
        matchedId: existing.id,
        confidence: 1.0,
      };
    }

    // Layer 4: Perceptual Hash (pHash)
    if (incoming.pHash && existing.pHash) {
      const dist = hammingDistance(incoming.pHash, existing.pHash);
      if (dist <= maxHamming) {
        return {
          isDuplicate: true,
          matchLayer: "perceptual_hash",
          matchedId: existing.id,
          confidence: Number((1.0 - dist / 64).toFixed(3)),
        };
      }
    }

    // Layer 5: Semantic Embedding Similarity
    if (incoming.embedding && existing.embedding) {
      const sim = cosineSimilarity(incoming.embedding, existing.embedding);
      if (sim >= minCosine) {
        return {
          isDuplicate: true,
          matchLayer: "embedding_similarity",
          matchedId: existing.id,
          confidence: Number(sim.toFixed(3)),
        };
      }
    }
  }

  return { isDuplicate: false, confidence: 0 };
}
