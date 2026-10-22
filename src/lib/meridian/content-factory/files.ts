/**
 * Files a person attaches to a Content Factory session. Every file is untrusted. Nothing here runs or renders a file's content, and a JSON
 * file is parsed only to check that it is valid.
 *
 * Binary types (video, images, PDF) are read from their first bytes, never from the name or the browser's claim. A text file must be
 * UTF-8 with no NUL bytes and no control character that plain text does not use. Its name only picks its text type (Markdown, CSV or
 * JSON; a JSON file must parse). A text file of at most TEXT_FILE_MAX_CHARS characters is read into the brief: its text comes back as
 * `content`, and the request sends it as a brief source. Every checked file is stored, so a text file also needs a brand and Drive.
 *
 * The bytes go to Meridian's storage layer (src/lib/meridian/storage: Google Drive, indexed by storage_objects), through the
 * ContentFactoryFileStore port. No vendor SDK and no other object store. Drive keeps files per brand, so a session needs a brand before
 * a file can be stored; without Drive connected, a file is refused as not connected and nothing is written.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { FILE_RULES, MAX_BASE64_CHARS, MAX_FILE_BYTES, TEXT_FILE_MAX_CHARS, type FileKind, type FilePurpose, type MediaTypeRule } from "./model.ts";

export { ACCEPTED_FILE_LABEL, FILE_RULES, MAX_BASE64_CHARS, MAX_FILE_BYTES, TEXT_FILE_MAX_CHARS } from "./model.ts";

const REFERENCE_REASON = "The reference must be a video file (MP4, MOV or WEBM).";

const SUBJECT: Record<FileKind, string> = { video: "This video", image: "This image", document: "This PDF", text: "This text file" };

function rule(mediaType: string): MediaTypeRule {
  const found = FILE_RULES.find((item) => item.mediaType === mediaType);
  if (!found) throw new Error(`no rule for ${mediaType}`);
  return found;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * The major brands of ISO base media files that are video, and the media type each one is. Any other ISO brand (HEIC and AVIF photos,
 * M4A audio, and the rest) is not a video, so an ISO file with another brand is refused rather than read as one.
 */
const VIDEO_BRANDS = new Map<string, string>([
  ["isom", "video/mp4"],
  ["iso2", "video/mp4"],
  ["iso4", "video/mp4"],
  ["iso5", "video/mp4"],
  ["iso6", "video/mp4"],
  ["mp41", "video/mp4"],
  ["mp42", "video/mp4"],
  ["avc1", "video/mp4"],
  ["M4V ", "video/mp4"],
  ["M4VH", "video/mp4"],
  ["qt  ", "video/quicktime"],
]);

/** The major brand of an ISO base media file (the four bytes after its "ftyp" box type), or null when the bytes are not one. */
function isoBrandOf(bytes: Uint8Array): string | null {
  return bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" ? ascii(bytes, 8, 4) : null;
}

/** A brand as a refusal names it: its letters and digits only, so a file's bytes never reach the message as they are. */
function brandLabel(brand: string): string {
  return brand.replace(/[^A-Za-z0-9]/g, "") || "unknown";
}

/** The media type of a binary file, read from its first bytes, or null when the bytes are not one of the binary types. */
export function sniffBinaryMediaType(bytes: Uint8Array): string | null {
  const brand = isoBrandOf(bytes);
  if (brand !== null) return VIDEO_BRANDS.get(brand) ?? null;
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** Width and height read from the image header. Null when the header does not say. No pixels are inspected. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes);
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function positiveSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 100_000 || height > 100_000) return null;
  return { width, height };
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || sniffBinaryMediaType(bytes) !== "image/png") return null;
  if (ascii(bytes, 12, 4) !== "IHDR") return null;
  return positiveSize(u32(bytes, 16), u32(bytes, 20));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffBinaryMediaType(bytes) !== "image/jpeg") return null;
  let index = 2;
  while (index + 8 < bytes.length) {
    if (bytes[index] !== 0xff) return null;
    while (bytes[index] === 0xff) index += 1;
    const marker = bytes[index];
    index += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    const length = u16(bytes, index);
    if (length < 2 || index + length > bytes.length) return null;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) return positiveSize(u16(bytes, index + 5), u16(bytes, index + 3));
    index += length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || sniffBinaryMediaType(bytes) !== "image/webp") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return positiveSize(width, height);
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8);
    const height = (bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8);
    return positiveSize(width & 0x3fff, height & 0x3fff);
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
    return positiveSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/** The text type of a text file, named by its extension. The bytes decide that it is text; the extension only picks the type. */
export function textMediaTypeOf(fileName: string): string {
  const extension = /\.([^./\\]+)$/.exec(fileName.trim())?.[1]?.toLowerCase() ?? "";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "json") return "application/json";
  return "text/plain";
}

/** Characters as the engine's schema and the database count them: a surrogate pair is one character, so an emoji counts once. */
export function characterCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const previous = index > 0 ? text.charCodeAt(index - 1) : 0;
    const pairedWithPrevious = code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff;
    if (!pairedWithPrevious) count += 1;
  }
  return count;
}

/** The text of a file that is not binary, or the plain reason it is not plain text: NUL bytes, bytes that are not UTF-8, or a control character. */
function readPlainText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  if (bytes.includes(0)) {
    return { ok: false, reason: "This file has NUL bytes, so it is not plain text, and this kind of file is not accepted. It was not stored." };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "This file is not valid UTF-8 text, so it was not stored. Save it as UTF-8 and try again." };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return { ok: false, reason: "This file has control characters that plain text does not use, so it was not stored." };
  }
  return { ok: true, text };
}

/** A file name safe to show and store: no path, no control characters, at most 120 characters. */
export function safeFileName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const last = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return (cleaned || "file").slice(0, 120);
}

/** A checked file. `content` is a text file's text (for the brief) and null for every other file. */
export type CheckedFile = { mediaType: string; kind: FileKind; extension: string; bytes: number; sha256: string; content: string | null };

export type FileCheck = { ok: true; file: CheckedFile } | { ok: false; reason: string };

/**
 * Checks one file's bytes for its purpose. A reference video must be a video. A text file is checked as text; when it has at most
 * TEXT_FILE_MAX_CHARS characters, its content comes back for the brief.
 */
export function checkFile(bytes: Uint8Array, purpose: FilePurpose, fileName = ""): FileCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "The file is empty, so it was not stored." };
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, reason: `The file is larger than ${MAX_FILE_BYTES / 1_000_000} MB, so it was not stored.` };
  // An ISO file with a brand that is not a video brand is refused here, before the plain-text check, which would refuse it with another reason.
  const brand = isoBrandOf(bytes);
  if (brand !== null && !VIDEO_BRANDS.has(brand)) return { ok: false, reason: `This file is not a video (its type is ${brandLabel(brand)}).` };
  const binary = sniffBinaryMediaType(bytes);
  if (binary !== null) return checkBinary(bytes, binary, purpose);
  const plain = readPlainText(bytes);
  if (!plain.ok) return { ok: false, reason: plain.reason };
  if (purpose === "reference_video") return { ok: false, reason: REFERENCE_REASON };
  return checkText(bytes, plain.text, fileName);
}

function checkBinary(bytes: Uint8Array, mediaType: string, purpose: FilePurpose): FileCheck {
  const found = rule(mediaType);
  if (found.maxBytes !== undefined && bytes.byteLength > found.maxBytes) {
    return { ok: false, reason: `${SUBJECT[found.kind]} can be at most ${found.maxBytes / 1_000_000} MB, so it was not stored.` };
  }
  if (purpose === "reference_video" && found.kind !== "video") return { ok: false, reason: REFERENCE_REASON };
  return { ok: true, file: checkedFile(bytes, found, null) };
}

function checkText(bytes: Uint8Array, text: string, fileName: string): FileCheck {
  if (text.trim() === "") return { ok: false, reason: "This text file has no text in it, so it was not stored." };
  const characters = characterCount(text);
  if (characters > TEXT_FILE_MAX_CHARS) {
    return { ok: false, reason: `This file has ${characters} characters; the limit for a text file is ${TEXT_FILE_MAX_CHARS}. Shorten it or split it into two files.` };
  }
  const found = rule(textMediaTypeOf(fileName));
  if (found.mediaType === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, reason: "This file is named as JSON, but its content is not valid JSON, so it was not stored." };
    }
  }
  return { ok: true, file: checkedFile(bytes, found, text) };
}

function checkedFile(bytes: Uint8Array, found: MediaTypeRule, content: string | null): CheckedFile {
  return {
    mediaType: found.mediaType,
    kind: found.kind,
    extension: found.extension,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content,
  };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes a base64 upload, refusing text that is not base64 or that is too long before anything is decoded. */
export function decodeUpload(base64: unknown): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (typeof base64 !== "string" || base64.length === 0) return { ok: false, reason: "No file was sent." };
  if (base64.length > MAX_BASE64_CHARS) return { ok: false, reason: `The file is larger than ${MAX_FILE_BYTES / 1_000_000} MB, so it was not stored.` };
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) return { ok: false, reason: "The file did not arrive whole. Try again." };
  return { ok: true, bytes: new Uint8Array(Buffer.from(base64, "base64")) };
}

/** Where a session's file is kept: under the session, named by its content hash, so the same file is stored once. */
export function sessionFileKey(sessionId: string, file: Pick<CheckedFile, "sha256" | "extension">): string {
  return `content-factory/${sessionId}/${file.sha256}.${file.extension}`;
}

/** The reference video as the engine's request names it (format.referenceVideo). The engine's reference source resolves it. */
export function referenceVideoUri(storageKey: string): string {
  return `store://${storageKey}`;
}

// --- Storage port ----------------------------------------------------------------------------------------------------------

export type FileStoreReadiness = { status: "ready" } | { status: "not_connected"; reason: string };

/** The storage a session's files go to. Production: Meridian's Drive-backed object store. Tests: an in-memory store. */
export type ContentFactoryFileStore = {
  ready(organizationId: string): Promise<FileStoreReadiness>;
  /** Stores the bytes. Returns the storage_objects row id when the storage layer records one. */
  put(input: { organizationId: string; brandId: string; key: string; mimeType: string; bytes: Uint8Array }): Promise<{ storageObjectId: string | null }>;
};

/**
 * Meridian's object store for session files: Google Drive, with each object recorded in storage_objects (object-store.ts). Drive's
 * health decides readiness, so a workspace with no Drive credential is not connected and no file is sent anywhere.
 */
export function driveFileStore(sql: Sql): ContentFactoryFileStore {
  return {
    async ready(organizationId) {
      const { GoogleDriveClient } = await import("../storage/drive.ts");
      const health = await new GoogleDriveClient().health(organizationId).catch((error: unknown) => ({
        status: "UNAVAILABLE" as const,
        detail: error instanceof Error ? error.message : "Google Drive could not be checked.",
      }));
      if (health.status === "HEALTHY") return { status: "ready" };
      return { status: "not_connected", reason: `Files cannot be stored yet. ${health.detail || "Google Drive is not connected for this workspace."}` };
    },
    async put(input) {
      const { createGoogleDriveObjectStore, createSqlStorageMetadataRepository } = await import("../storage/object-store.ts");
      const store = createGoogleDriveObjectStore(undefined, { metadataRepo: createSqlStorageMetadataRepository(sql) });
      await store.put({ ...input, lifecycle: "stored" });
      const rows = await sql<{ id: string }>`
        select id from storage_objects
        where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and name = ${input.key}
        limit 1
      `;
      return { storageObjectId: rows[0]?.id ?? null };
    },
  };
}
