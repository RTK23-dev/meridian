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

