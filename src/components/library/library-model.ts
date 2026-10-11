/**
 * Pure helpers for the Library screen. No React and no server imports, so every rule here can be tested directly.
 */

/** One creative from listLibrary. assetId is the stored asset's id, or null when no stored asset exists. */
export type LibraryCreative = {
  id: string;
  title: string;
  origin: string;
  angle: string;
  hook: string;
  status: string;
  createdAt: string;
  assetId: string | null;
  assetKind: string;
  assetMediaStatus: string;
};

/**
 * One stored asset linked to a creative, from the studio session's variants. Only the fields the library reads.
 * `assetId` is the id the asset route serves (/api/assets/<assetId>). An empty id means no asset row is linked.
 */
export type LibraryMediaVariant = {
  creativeId: string;
  assetId: string;
  kind: string;
  index: number;
  provider: string;
  model: string;
  mediaStatus: string;
  qaDecision: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

/** Whether a source query has answered. While it has not, no creative is shown as having none of that source. */
export type MediaLoad = "loading" | "unavailable" | "ready";

/** `unknown` means the media query has not answered, so the creative's media is not known yet. */
export type MediaKind = "image" | "video" | "none" | "unknown";

const STORED_MEDIA_STATUSES = new Set(["completed", "stored"]);

/** A variant has stored media only when its asset id is present and its media status says the bytes were kept. */
export function hasStoredMedia(variant: LibraryMediaVariant): boolean {
  return variant.assetId.length > 0 && STORED_MEDIA_STATUSES.has(variant.mediaStatus);
}

/** Groups variants by creative. Each group is ordered by variant index, so the first entry is the earliest variant. */
export function groupMediaByCreative(variants: readonly LibraryMediaVariant[]): Map<string, LibraryMediaVariant[]> {
  const groups = new Map<string, LibraryMediaVariant[]>();
  for (const variant of variants) {
    const group = groups.get(variant.creativeId) ?? [];
    group.push(variant);
    groups.set(variant.creativeId, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.index - right.index);
  return groups;
}

/**
 * The media each creative shows. Studio variants give the full set with their facts, and they win for a creative they
 * cover. A creative the studio does not list falls back to the asset id the library listing returns, so its thumbnail still
 * loads. The fallback carries no dimensions, so its box stays a layout hint.
 */
export function mediaByCreative(creatives: readonly LibraryCreative[], studioVariants: readonly LibraryMediaVariant[]): Map<string, LibraryMediaVariant[]> {
  const groups = groupMediaByCreative(studioVariants);
  for (const creative of creatives) {
    if (groups.has(creative.id) || !creative.assetId) continue;
    groups.set(creative.id, [{
      creativeId: creative.id,
      assetId: creative.assetId,
      kind: creative.assetKind,
      index: 0,
      provider: "",
      model: "",
      mediaStatus: creative.assetMediaStatus,
      qaDecision: "",
      width: null,
      height: null,
      durationMs: null,
    }]);
  }
  return groups;
}

/** The first variant with stored media, or null when none has been kept. */
export function primaryMedia(variants: readonly LibraryMediaVariant[]): LibraryMediaVariant | null {
  return variants.find(hasStoredMedia) ?? null;
}

/** The kind a creative's preview uses. Unknown until the media query has answered. */
export function mediaKindFor(load: MediaLoad, variants: readonly LibraryMediaVariant[]): MediaKind {
  if (load !== "ready") return "unknown";
  const primary = primaryMedia(variants);
  if (!primary) return "none";
  return primary.kind === "video" ? "video" : "image";
}

export function assetPath(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

/** Images are served whole. A video uses its stored still (?thumb=1) and is never served as a stand-in image. */
export function thumbnailSrc(variant: LibraryMediaVariant): string {
  return variant.kind === "video" ? `${assetPath(variant.assetId)}?thumb=1` : assetPath(variant.assetId);
}

export function downloadHref(assetId: string): string {
  return `${assetPath(assetId)}?download=1`;
}

/**
 * The box a preview is laid out in before it loads. Stored dimensions win. Without them the box is only a layout
 * hint (16:9 for video, square for image) and is never presented as the real size.
 */
export function previewBox(variant: LibraryMediaVariant): { width: number; height: number } {
  const { width, height } = variant;
  if (width !== null && height !== null && width > 0 && height > 0) return { width, height };
  return variant.kind === "video" ? { width: 16, height: 9 } : { width: 1, height: 1 };
}

export type LibraryFilters = {
  search: string;
  status: string;
  kind: string;
  angle: string;
  origin: string;
  createdAfter: string;
  createdBefore: string;
};

export const NO_LIBRARY_FILTERS: LibraryFilters = {
  search: "",
  status: "all",
  kind: "all",
  angle: "all",
  origin: "all",
  createdAfter: "",
  createdBefore: "",
};

/** Filter values that narrow the list. `all` and an empty date are the defaults. */
export function countActiveFilters(filters: LibraryFilters): number {
  let count = 0;
  if (filters.search.trim()) count += 1;
  if (filters.status !== "all") count += 1;
  if (filters.kind !== "all") count += 1;
  if (filters.angle !== "all") count += 1;
  if (filters.origin !== "all") count += 1;
  if (filters.createdAfter) count += 1;
  if (filters.createdBefore) count += 1;
  return count;
}

/** Start of a calendar day in local time, the same reading the date inputs use. */
export function startOfDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00`);
}

/** End of a calendar day in local time, inclusive. */
export function endOfDayMs(day: string): number {
  return Date.parse(`${day}T23:59:59.999`);
}

/**
 * True when the creative passes every active filter. A date filter excludes a creative whose date cannot be read,
 * because it cannot be shown to be inside the range.
 */
export function matchesLibraryFilters(item: LibraryCreative, filters: LibraryFilters, kind: MediaKind): boolean {
  const needle = filters.search.trim().toLowerCase();
  if (needle && !`${item.title} ${item.hook} ${item.angle}`.toLowerCase().includes(needle)) return false;
  if (filters.status !== "all" && item.status !== filters.status) return false;
  if (filters.origin !== "all" && item.origin !== filters.origin) return false;
  if (filters.angle !== "all" && item.angle !== filters.angle) return false;
  if (filters.kind !== "all" && kind !== filters.kind) return false;
  if (filters.createdAfter || filters.createdBefore) {
    const created = Date.parse(item.createdAt);
    if (Number.isNaN(created)) return false;
    if (filters.createdAfter && created < startOfDayMs(filters.createdAfter)) return false;
    if (filters.createdBefore && created > endOfDayMs(filters.createdBefore)) return false;
  }
  return true;
}

export function filterLibraryCreatives(
  items: readonly LibraryCreative[],
  filters: LibraryFilters,
  kindOf: (creativeId: string) => MediaKind,
): LibraryCreative[] {
  return items.filter((item) => matchesLibraryFilters(item, filters, kindOf(item.id)));
}

/** Distinct non-empty values, sorted, for the filter selects. */
export function distinctValues(items: readonly LibraryCreative[], pick: (item: LibraryCreative) => string): string[] {
  return [...new Set(items.map(pick).filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}
