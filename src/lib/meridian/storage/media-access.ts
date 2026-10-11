import { isRole, type Role } from "../access.ts";
import { detectArtifactType } from "../production/mime-detector.ts";

export type ByteRange = { start: number; end: number };

/** The workspace a signed-in user is working in: the saved preference when they still belong to it, otherwise their earliest membership. */
export type ActiveWorkspace = { organizationId: string; role: Role };

export function parseByteRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size < 0) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function canAccessStoredAsset(input: {
  assetOrganizationId: string;
  blobOrganizationId: string;
  assetBrandId: string;
  blobBrandId: string;
  memberOrganizationIds: readonly string[];
}): boolean {
  return input.assetOrganizationId === input.blobOrganizationId
    && input.assetBrandId === input.blobBrandId
    && input.memberOrganizationIds.includes(input.assetOrganizationId);
}

/**
 * Picks the active workspace the way the workspace loader does: the saved preference wins when it is one of the user's
 * memberships, otherwise the first membership (ordered by organization creation) is used. Rows with an unknown role are
 * dropped, so a membership that cannot be read never grants access.
 */
export function pickActiveOrganization(
  preferredOrganizationId: string | null | undefined,
  memberships: readonly { organizationId: string; role: string }[],
): ActiveWorkspace | null {
  const valid: ActiveWorkspace[] = [];
  for (const membership of memberships) {
    if (isRole(membership.role)) valid.push({ organizationId: membership.organizationId, role: membership.role });
  }
  if (valid.length === 0) return null;
  return valid.find((membership) => membership.organizationId === preferredOrganizationId) ?? valid[0] ?? null;
}

/** True only when the asset belongs to the active workspace. With no active workspace, nothing matches. */
export function isInActiveWorkspace(assetOrganizationId: string, active: ActiveWorkspace | null): boolean {
  return active !== null && active.organizationId === assetOrganizationId;
}

/**
 * Only still images and MP4 video are served. SVG is excluded even though it is an image type, because it can carry
 * script. HTML and every other type are refused.
 */
export function isPreviewableMime(mimeType: string): boolean {
  const mime = mimeType.trim().toLowerCase();
  if (mime === "video/mp4") return true;
  return /^image\/[a-z0-9.+-]+$/.test(mime) && mime !== "image/svg+xml";
}

/**
 * The MIME type to serve, or null. The stored type must be previewable, and the bytes must sniff as that same type from
 * their magic numbers. HTML, JSON error payloads and unknown formats sniff as nothing, so they are never served as media.
 */
export function verifiedMediaMime(bytes: Uint8Array, storedMimeType: string): string | null {
  const declared = storedMimeType.trim().toLowerCase();
  const stored = declared === "image/jpg" ? "image/jpeg" : declared;
  if (!isPreviewableMime(stored)) return null;
  try {
    return detectArtifactType(bytes).mimeType === stored ? stored : null;
  } catch {
    return null;
  }
}

/** True when the bytes have exactly the length and SHA-256 that the store recorded. A record without both never matches. */
export function storedBytesMatch(
  actual: { byteLength: number; sha256Hex: string },
  recorded: { byteSize: number; sha256Hex: string },
): boolean {
  return Number.isSafeInteger(recorded.byteSize)
    && recorded.byteSize > 0
    && /^[0-9a-f]{64}$/i.test(recorded.sha256Hex)
    && actual.byteLength === recorded.byteSize
    && actual.sha256Hex.toLowerCase() === recorded.sha256Hex.toLowerCase();
}

/**
 * The key of the stored poster for a video. The studio's video persistence writes the first embedded still beside the
 * container under this key. That still is not guaranteed to be at t=0.
 */
export function framePosterStorageKey(videoStorageKey: string): string {
  return `${videoStorageKey}.frame.0.png`;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
};

/** `inline` for previews. `attachment` with a filename built from the asset id, for `?download=1`. */
export function contentDispositionFor(input: { download: boolean; assetId: string; mimeType: string }): string {
  if (!input.download) return "inline";
  const stem = input.assetId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "asset";
  return `attachment; filename="${stem}.${EXTENSION_BY_MIME[input.mimeType] ?? "bin"}"`;
}

/** True when If-None-Match names the current ETag, or is `*`. Weak and strong tags are compared the same way. */
export function isNotModified(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const tags = ifNoneMatch.split(",").map((tag) => tag.trim());
  if (tags.includes("*")) return true;
  const current = etag.replace(/^W\//, "");
  return tags.some((tag) => tag.replace(/^W\//, "") === current);
}
