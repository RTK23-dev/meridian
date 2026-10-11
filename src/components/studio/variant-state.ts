/**
 * What a variant's stored state allows. Pure. The labels for each state come from the stored values through statusLabel;
 * this file only decides which phase a variant is in and which actions it offers.
 */

export type MediaPhase = "stored" | "in_flight" | "failed" | "unknown";

/** Media statuses the generation path writes while a provider is still working. */
const IN_FLIGHT_STATUSES = new Set(["queued", "submitted", "running", "processing"]);
const STORED_STATUSES = new Set(["completed", "stored", "succeeded"]);

export function mediaPhase(mediaStatus: string): MediaPhase {
  const status = mediaStatus.trim().toLowerCase();
  if (STORED_STATUSES.has(status)) return "stored";
  if (IN_FLIGHT_STATUSES.has(status)) return "in_flight";
  if (status === "failed") return "failed";
  return "unknown";
}

/** A stored asset can be shown. An unknown status is tried, and the player reports the failure if the bytes are missing. */
export function showsMedia(phase: MediaPhase): boolean {
  return phase === "stored" || phase === "unknown";
}

/** The asset route serves a file only when its asset row is 'stored'. Any other status means the file is not stored yet. */
export function hasStoredFile(variant: { assetStatus: string }): boolean {
  return variant.assetStatus.trim().toLowerCase() === "stored";
}

/** Review actions show only for a variant waiting for review, and only to a role that may review. */
export function canReview(variant: { creativeStatus: string }, canEdit: boolean): boolean {
  return canEdit && variant.creativeStatus === "in_review";
}

/** Publishing shows only for an approved or testing variant, and only to a role that may publish. */
export function canPublish(variant: { creativeStatus: string }, canEdit: boolean): boolean {
  return canEdit && (variant.creativeStatus === "approved" || variant.creativeStatus === "testing");
}

/** A failed generation can be retried. The retry opens the Generate step; it does not start a billable run by itself. */
export function canRetry(variant: { mediaStatus: string }, canEdit: boolean): boolean {
  return canEdit && mediaPhase(variant.mediaStatus) === "failed";
}

export function kindLabel(kind: string): string {
  if (kind === "video") return "Video";
  if (kind === "image") return "Image";
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Variant";
}
