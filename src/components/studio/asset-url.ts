/**
 * Routes for stored media. Images and video are read through the asset route, which checks the session and the workspace.
 * Gallery data never carries the bytes as base64.
 */

export function assetRoute(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

export function assetDownloadRoute(assetId: string): string {
  return `${assetRoute(assetId)}?download=1`;
}
