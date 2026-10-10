/**
 * Image validation before any provider sees the bytes. An image is checked by its own bytes, never by its name or the
 * caller's claim: the format must be one a provider accepts, and the size is capped per image and in total.
 */
import { detectArtifactType } from "../production/mime-detector.ts";

export const ACCEPTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024;

export function checkImageBytes(
  bytes: Uint8Array,
  label: string,
): { ok: true; mimeType: AcceptedImageMimeType } | { ok: false; reason: string } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, reason: `${label} has no bytes.` };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `${label} is ${bytes.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES}.` };
  }
  let detected: string;
  try {
    detected = detectArtifactType(bytes).mimeType;
  } catch (error) {
    return { ok: false, reason: `${label} is not a readable image: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(detected)) {
    return { ok: false, reason: `${label} is ${detected}; accepted types are ${ACCEPTED_IMAGE_MIME_TYPES.join(", ")}.` };
  }
  return { ok: true, mimeType: detected as AcceptedImageMimeType };
}
