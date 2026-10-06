export type ByteRange = { start: number; end: number };

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

export function isPreviewableMime(mimeType: string): boolean {
  return /^image\/[a-z0-9.+-]+$/i.test(mimeType) || mimeType.toLowerCase() === "video/mp4";
}
