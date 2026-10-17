/**
 * Files a person attaches to a Content Factory session. Every file is untrusted: its type is read from its bytes, never from its name or
 * the browser's claim, and it is refused unless it is one of the few types the session uses and within that type's size limit. Nothing
 * here runs, parses or renders a file's content.
 *
 * The bytes go to Meridian's storage layer (src/lib/meridian/storage: Google Drive, indexed by storage_objects), through the
 * ContentFactoryFileStore port. No vendor SDK and no other object store. Drive keeps files per brand, so a session needs a brand before
 * a file can be stored; without Drive connected, a file is refused as not connected and nothing is written.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { ACCEPTED_FILE_LABEL, FILE_RULES, MAX_BASE64_CHARS, MAX_FILE_BYTES, type FileKind, type FilePurpose, type MediaTypeRule } from "./model.ts";

export { ACCEPTED_FILE_LABEL, FILE_RULES, MAX_BASE64_CHARS, MAX_FILE_BYTES } from "./model.ts";

function rule(mediaType: string): MediaTypeRule {
  const found = FILE_RULES.find((item) => item.mediaType === mediaType);
  if (!found) throw new Error(`no rule for ${mediaType}`);
  return found;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

const QUICKTIME_BRANDS = new Set(["qt  "]);

/** The media type read from a file's first bytes, or null when it is none of the accepted types. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    return QUICKTIME_BRANDS.has(ascii(bytes, 8, 4)) ? "video/quicktime" : "video/mp4";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (isPlainText(bytes)) return "text/plain";
  return null;
}

/** UTF-8 text with no NUL and no control character other than tab, line feed and carriage return. */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/** A file name safe to show and store: no path, no control characters, at most 120 characters. */
export function safeFileName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const last = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return (cleaned || "file").slice(0, 120);
}

export type CheckedFile = { mediaType: string; kind: FileKind; extension: string; bytes: number; sha256: string };

export type FileCheck = { ok: true; file: CheckedFile } | { ok: false; reason: string };

/** Checks one file's bytes for its purpose. A reference video must be a video. */
export function checkFile(bytes: Uint8Array, purpose: FilePurpose): FileCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "The file is empty, so it was not stored." };
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, reason: `The file is larger than ${MAX_FILE_BYTES / 1_000_000} MB, so it was not stored.` };
  const mediaType = sniffMediaType(bytes);
  if (mediaType === null) return { ok: false, reason: `This kind of file is not accepted. The session takes ${ACCEPTED_FILE_LABEL}.` };
  const found = rule(mediaType);
  if (bytes.byteLength > found.maxBytes) {
    return { ok: false, reason: `A ${found.kind} file can be at most ${found.maxBytes / 1_000_000} MB, so it was not stored.` };
  }
  if (purpose === "reference_video" && found.kind !== "video") {
    return { ok: false, reason: "The reference must be a video file (MP4, MOV or WEBM)." };
  }
  return { ok: true, file: { mediaType, kind: found.kind, extension: found.extension, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } };
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
