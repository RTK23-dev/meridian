// The files a connector makes (a voiceover, an image) and the links a chat opens them with. The bytes go to Meridian's storage layer
// (storage/meridian-store.ts: the workspace's Google Drive when it has one, else Meridian's own database; indexed by storage_objects), never
// to a vendor SDK, under the brand, or in the workspace's own space for a video made without one (brandId null). Each file is a row of
// mcp_files with the cost the provider reported (null when it reported none).
//
// A link is an HMAC-SHA256 over the file id and an expiry, signed with MEDIA_LINK_SECRET under its own label, so a creative's media link and
// a connector file's link can never stand in for each other. It lasts an hour: long enough for a chat to fetch the files and render. The
// route that serves it (routes/api/mcp-files) checks the signature and the expiry before it reads anything.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export const MCP_FILE_LINK_TTL_SECONDS = 60 * 60;
const SIGNING_LABEL = "meridian-mcp-file:v1";
const MIN_SECRET_LENGTH = 32;

export type McpFileKind = "voiceover" | "image" | "video";

export type McpFileStore = {
  ready(organizationId: string): Promise<{ status: "ready"; detail?: string } | { status: "not_connected"; reason: string }>;
  put(input: { organizationId: string; brandId: string | null; key: string; mimeType: string; bytes: Uint8Array }): Promise<{ storageObjectId: string | null }>;
  get(input: { organizationId: string; brandId: string | null; key: string }): Promise<Uint8Array | null>;
};

export type McpFile = {
  id: string;
  /** Null: a file of a video made without a brand, kept in the workspace's own space. */
  brandId: string | null;
  projectId: string | null;
  kind: McpFileKind;
  mediaType: string;
  bytes: number;
  costUsd: number | null;
  details: Record<string, unknown>;
  createdAt: string;
};

const EXTENSIONS: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" };

function signatureOf(secret: string, fileId: string, expires: number): string {
  return createHmac("sha256", secret).update(`${SIGNING_LABEL}\n${fileId}\n${expires}`).digest("hex");
}

/** The link secret, or null when it is missing or too short to sign with. */
export function linkSecretFrom(env: Record<string, string | undefined>): string | null {
  const secret = env.MEDIA_LINK_SECRET?.trim() ?? "";
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** A signed link to one file, or null when there is no secret to sign with (nothing is guessed or left unsigned). */
export function fileLink(input: { origin: string; fileId: string; nowSeconds: number; secret: string | null }): { url: string; expiresAt: string } | null {
  if (!input.secret) return null;
  const expires = input.nowSeconds + MCP_FILE_LINK_TTL_SECONDS;
  const sig = signatureOf(input.secret, input.fileId, expires);
  const url = `${input.origin.replace(/\/+$/, "")}/api/mcp-files/${encodeURIComponent(input.fileId)}?expires=${expires}&sig=${sig}`;
  return { url, expiresAt: new Date(expires * 1000).toISOString() };
}

export type FileLinkCheck = "ok" | "malformed" | "bad_signature" | "expired";

export function verifyFileLink(input: { fileId: string; expires: string | null; sig: string | null; secret: string; nowSeconds: number }): FileLinkCheck {
  if (!input.fileId || !input.expires || !input.sig) return "malformed";
  if (!/^\d{1,12}$/.test(input.expires) || !/^[0-9a-f]{64}$/.test(input.sig)) return "malformed";
  const expires = Number(input.expires);
  const expected = Buffer.from(signatureOf(input.secret, input.fileId, expires), "hex");
  const given = Buffer.from(input.sig, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "bad_signature";
  return expires <= input.nowSeconds ? "expired" : "ok";
}

/** Where a connector file is kept: under the connector, named by its content hash. */
export function fileKey(connectorId: string, sha256: string, mediaType: string): string {
  return `mcp/${connectorId}/${sha256}.${EXTENSIONS[mediaType] ?? "bin"}`;
}

/** Stores the bytes and records the file. Throws when the store refuses; nothing is recorded then. */
export async function storeFile(
  sql: Sql,
  store: McpFileStore,
  input: { organizationId: string; brandId: string | null; connectorId: string; projectId?: string | null; kind: McpFileKind; mediaType: string; bytes: Uint8Array; costUsd: number | null; details: Record<string, unknown> },
): Promise<McpFile> {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const key = fileKey(input.connectorId, sha256, input.mediaType);
  const { storageObjectId } = await store.put({ organizationId: input.organizationId, brandId: input.brandId, key, mimeType: input.mediaType, bytes: input.bytes });
  const id = randomUUID();
  const rows = await sql<{ created_at: unknown }>`
    insert into mcp_files (id, organization_id, brand_id, connector_id, project_id, kind, storage_key, storage_object_id, media_type, byte_size, sha256, details, cost_usd)
    values (${id}, ${input.organizationId}, ${input.brandId}, ${input.connectorId}, ${input.projectId ?? null}, ${input.kind}, ${key}, ${storageObjectId}, ${input.mediaType},
      ${input.bytes.byteLength}, ${sha256}, ${JSON.stringify(input.details)}::jsonb, ${input.costUsd})
    returning created_at
  `;
  return { id, brandId: input.brandId, projectId: input.projectId ?? null, kind: input.kind, mediaType: input.mediaType, bytes: input.bytes.byteLength, costUsd: input.costUsd, details: input.details, createdAt: new Date(rows[0]!.created_at as string).toISOString() };
}

type FileRow = { id: string; brand_id: string | null; project_id: string | null; kind: McpFileKind; media_type: string; byte_size: string | number; cost_usd: string | number | null; details: unknown; created_at: unknown; storage_key: string; organization_id: string };

function fileOf(row: FileRow): McpFile {
  const details = typeof row.details === "string" ? (JSON.parse(row.details) as Record<string, unknown>) : ((row.details ?? {}) as Record<string, unknown>);
  return { id: row.id, brandId: row.brand_id, projectId: row.project_id ?? null, kind: row.kind, mediaType: row.media_type, bytes: Number(row.byte_size), costUsd: row.cost_usd === null ? null : Number(row.cost_usd), details, createdAt: new Date(row.created_at as string).toISOString() };
}

/** The workspace's connector files, newest first; one project's or one brand's only when one is given. */
export async function listFiles(sql: Sql, input: { organizationId: string; brandId?: string | null; projectId?: string | null; limit?: number }): Promise<McpFile[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  if (input.projectId) {
    const rows = await sql<FileRow>`select * from mcp_files where organization_id = ${input.organizationId} and project_id = ${input.projectId} order by created_at desc limit ${limit}`;
    return rows.map(fileOf);
  }
  const rows = input.brandId
    ? await sql<FileRow>`select * from mcp_files where organization_id = ${input.organizationId} and brand_id = ${input.brandId} order by created_at desc limit ${limit}`
    : await sql<FileRow>`select * from mcp_files where organization_id = ${input.organizationId} order by created_at desc limit ${limit}`;
  return rows.map(fileOf);
}

/** One file of the workspace, or null. */
export async function fileOfWorkspace(sql: Sql, organizationId: string, fileId: string): Promise<McpFile | null> {
  const rows = await sql<FileRow>`select * from mcp_files where id = ${fileId} and organization_id = ${organizationId} limit 1`;
  return rows[0] ? fileOf(rows[0]) : null;
}

/** The stored row a signed link names, for the route that serves it. */
export async function storedFileFor(sql: Sql, fileId: string): Promise<{ organizationId: string; brandId: string | null; key: string; mediaType: string } | null> {
  const rows = await sql<FileRow>`select * from mcp_files where id = ${fileId} limit 1`;
  const row = rows[0];
  return row ? { organizationId: row.organization_id, brandId: row.brand_id, key: row.storage_key, mediaType: row.media_type } : null;
}

/**
 * Meridian's storage for connector files: writes as the Content Factory makes them, reads by key. It is always ready: without Drive, files
 * are kept in Meridian's own database, and the detail says which (owner direction 2026-11-09).
 */
export async function meridianMcpFileStore(
  sql: Sql,
  home?: (organizationId: string) => Promise<import("../storage/meridian-store.ts").StorageHome>,
): Promise<McpFileStore> {
  const { createMeridianObjectStore } = await import("../storage/meridian-store.ts");
  const store = createMeridianObjectStore(sql, home ? { home } : {});
  return {
    async ready(organizationId) {
      const home = await store.home(organizationId);
      return { status: "ready", detail: home.detail };
    },
    async put(input) {
      await store.put({ ...input, lifecycle: "stored" });
      const rows = await sql<{ id: string }>`
        select id from storage_objects
        where organization_id = ${input.organizationId} and brand_id is not distinct from ${input.brandId} and name = ${input.key}
        limit 1
      `;
      return { storageObjectId: rows[0]?.id ?? null };
    },
    async get(input) {
      const object = await store.get(input.organizationId, input.brandId, input.key);
      return object?.bytes ?? null;
    },
  };
}
