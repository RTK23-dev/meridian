/**
 * Strict Fail-Closed Magic-Byte MIME Detector
 *
 * Implements Section P0.6 of Hardening / Release-Blocker Fixes:
 * - Detects true media format via binary magic bytes (never trusts extension or raw strings)
 * - Explicitly rejects HTML error pages, JSON error responses, and corrupted headers
 * - Throws UnknownArtifactFormatError instead of silently guessing or defaulting to video/mp4
 */

export class UnknownArtifactFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownArtifactFormatError";
  }
}

export interface DetectedArtifactFormat {
  mimeType: string;
  extension: string;
  category: "video" | "image" | "document";
}

export function detectArtifactType(bytes: Uint8Array): DetectedArtifactFormat {
  if (!bytes || bytes.byteLength < 8) {
    throw new UnknownArtifactFormatError(
      `Artifact byte length (${bytes ? bytes.byteLength : 0}) is too short for format signature validation.`
    );
  }

  // 1. Explicitly check for and reject text/HTML/JSON error payloads
  const prefixAscii = String.fromCharCode(...bytes.slice(0, Math.min(bytes.length, 64))).toLowerCase();
  if (
    prefixAscii.startsWith("<!doctype") ||
    prefixAscii.startsWith("<html") ||
    prefixAscii.startsWith("<?xml") ||
    prefixAscii.startsWith("<error") ||
    prefixAscii.includes("<head>") ||
    prefixAscii.includes("<body>")
  ) {
    throw new UnknownArtifactFormatError("Rejected non-media payload: detected HTML error document.");
  }

  if (
    prefixAscii.startsWith('{"error"') ||
    prefixAscii.startsWith('{"message"') ||
    prefixAscii.startsWith('{\n  "error"') ||
    prefixAscii.startsWith('{\n  "message"') ||
    prefixAscii.startsWith('{"status":"error"') ||
    prefixAscii.startsWith('{"code":')
  ) {
    throw new UnknownArtifactFormatError("Rejected non-media payload: detected JSON error response.");
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png", category: "image" };
  }

  // 3. JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg", category: "image" };
  }

  // 4. WEBP: RIFF .... WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mimeType: "image/webp", extension: "webp", category: "image" };
  }

  // 5. GIF: GIF87a or GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mimeType: "image/gif", extension: "gif", category: "image" };
  }

  // 6. MP4: ....ftyp
  // Standard MP4 box header: 4 bytes length, followed by 'ftyp' (0x66 0x74 0x79 0x70)
  if (
    bytes.length >= 16 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return { mimeType: "video/mp4", extension: "mp4", category: "video" };
  }

  // 7. WEBM / MKV: 1A 45 DF A3 (EBML ID)
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return { mimeType: "video/webm", extension: "webm", category: "video" };
  }

  // 8. QuickTime MOV: ....moov or ....wide or ....mdat
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x6d &&
    ((bytes[5] === 0x6f && bytes[6] === 0x6f && bytes[7] === 0x76) || // moov
      (bytes[5] === 0x64 && bytes[6] === 0x61 && bytes[7] === 0x74)) // mdat
  ) {
    return { mimeType: "video/quicktime", extension: "mov", category: "video" };
  }

  // 9. PDF: %PDF (25 50 44 46)
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return { mimeType: "application/pdf", extension: "pdf", category: "document" };
  }

  // Never guess. Reject unknown binary stream.
  throw new UnknownArtifactFormatError(
    `Unsupported or unrecognized artifact format. Magic bytes: [${Array.from(bytes.slice(0, 8))
      .map((b) => "0x" + b.toString(16).padStart(2, "0"))
      .join(", ")}]. Pipeline fails closed.`
  );
}
