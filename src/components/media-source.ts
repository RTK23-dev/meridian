/**
 * Pure rules for the media player: where a stored asset is served from, which poster a video shows, the aspect ratio and
 * the duration text. Kept free of React so each rule can be tested under plain Node.
 */

/** The URL a stored asset is served from. The id is encoded, so it cannot change the path. */
export function assetSource(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

/**
 * The poster for a video. An explicit poster wins, and null means no poster. Without one, a stored asset shows its stored
 * still (`?thumb=1`). A plain media URL with no poster shows none.
 */
export function posterSource(input: { poster?: string | null; assetId?: string }): string | undefined {
  if (input.poster !== undefined) return input.poster ?? undefined;
  return input.assetId !== undefined ? `${assetSource(input.assetId)}?thumb=1` : undefined;
}

/** The box shape. A missing or zero dimension falls back to 16:9 rather than an invented size. */
export function aspectRatio(width: number | null | undefined, height: number | null | undefined): string {
  return width && height ? `${width} / ${height}` : "16 / 9";
}

/** The duration as words. A missing, zero or non-finite duration is stated as not stored, never as 0 seconds. */
export function durationLabel(durationMs: number | null | undefined): string {
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
    ? `${(durationMs / 1000).toFixed(1)} seconds`
    : "duration not stored";
}
