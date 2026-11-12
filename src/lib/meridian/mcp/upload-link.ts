// A one-time-use style upload address for a finished file, so a coding agent (Claude Code) that rendered a video on its own machine can save
// it back to Meridian. The address carries its own claims (which connector, workspace, brand and project, which media type, the largest size,
// when it expires), signed with MEDIA_LINK_SECRET under its own label, so a download link, an engine link and an upload link can never stand
// in for one another. It is short-lived and bound to one connector: revoking the connector stops the upload even before the address expires.

import { createHmac, timingSafeEqual } from "node:crypto";

export const UPLOAD_LINK_TTL_SECONDS = 15 * 60;
/** The largest upload. Meridian's own database keeps a file up to this size; a larger one needs Google Drive and is not taken here. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNING_LABEL = "meridian-mcp-upload:v1";

/** What may be uploaded, and the kind of file each becomes. */
export const UPLOAD_MEDIA_TYPES = { "video/mp4": "video", "audio/mpeg": "voiceover", "audio/wav": "voiceover", "image/png": "image", "image/jpeg": "image" } as const;
export type UploadMediaType = keyof typeof UPLOAD_MEDIA_TYPES;

export function isUploadMediaType(value: unknown): value is UploadMediaType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UPLOAD_MEDIA_TYPES, value);
}

export type UploadClaims = {
  connectorId: string;
  organizationId: string;
  brandId: string | null;
  projectId: string | null;
  mediaType: UploadMediaType;
  maxBytes: number;
  /** Seconds since the epoch. */
  expires: number;
};

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`${SIGNING_LABEL}\n${payload}`).digest("base64url");
}

/** The upload token for these claims. */
export function uploadToken(secret: string, claims: UploadClaims): string {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(secret, payload)}`;
}

/** The address to send the file to, or null when there is no secret to sign with. */
export function uploadLink(input: { origin: string; secret: string | null; nowSeconds: number; claims: Omit<UploadClaims, "expires" | "maxBytes"> & { maxBytes?: number } }): { url: string; expiresAt: string } | null {
  if (!input.secret) return null;
  const expires = input.nowSeconds + UPLOAD_LINK_TTL_SECONDS;
  const claims: UploadClaims = { ...input.claims, maxBytes: Math.min(input.claims.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES), expires };
  return { url: `${input.origin.replace(/\/+$/, "")}/api/mcp-upload/${uploadToken(input.secret, claims)}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export type UploadCheck = { ok: true; claims: UploadClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Checks the signature first and the expiry second; the claims are read only once the signature holds. */
export function verifyUploadToken(token: string, secret: string, nowSeconds: number): UploadCheck {
  const dot = token.indexOf(".");
  if (dot < 1 || token.length > 2000) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(secret, payload), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let claims: UploadClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UploadClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid =
    claims && typeof claims.connectorId === "string" && typeof claims.organizationId === "string" &&
    (claims.brandId === null || typeof claims.brandId === "string") && (claims.projectId === null || typeof claims.projectId === "string") &&
    isUploadMediaType(claims.mediaType) && Number.isInteger(claims.maxBytes) && claims.maxBytes > 0 && claims.maxBytes <= MAX_UPLOAD_BYTES && Number.isInteger(claims.expires);
  if (!valid) return { ok: false, reason: "malformed" };
  return claims.expires <= nowSeconds ? { ok: false, reason: "expired" } : { ok: true, claims };
}
