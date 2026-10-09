import { normalizeCanonicalUrl } from "../evidence/dedupe.ts";

function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The `sources.external_id` a discovered item maps to.
 *
 * An item with a web URL shares one source per brand across runs, so the same page found twice is
 * one source. The brand is part of the key, because the `sources` uniqueness constraint is per
 * organization: without it, the second brand would overwrite the first brand's row.
 *
 * An item without a web URL (a niche handle, or a free-text seed) keeps its run-scoped id. Two
 * unrelated results that share a seed string must not merge.
 */
export function sourceExternalId(input: { brandId: string; itemId: string; canonicalUrl: string | null | undefined }): string {
  const url = input.canonicalUrl?.trim() ?? "";
  if (url && isWebUrl(url)) {
    return `${input.brandId}|url:${normalizeCanonicalUrl(url)}`;
  }
  return `${input.brandId}|item:${input.itemId}`;
}
