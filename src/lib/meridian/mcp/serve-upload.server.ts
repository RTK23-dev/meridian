// Takes one finished file by its signed upload address. The signature and expiry are checked before anything is read; the connector must still
// be active; the project (when named) must belong to the workspace; the body is counted as it is read and refused past the signed size. The
// bytes then go through the same storage layer as every other connector file. Nothing the file contains is run or interpreted.
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { linkSecretFrom, meridianMcpFileStore, storeFile, type McpFileStore } from "./files.ts";
import { UPLOAD_MEDIA_TYPES, verifyUploadToken } from "./upload-link.ts";

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Reads the request body, stopping as soon as it passes the limit. Returns null when it is too large. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** True when the bytes look like the media type they are said to be, by their first bytes. A wrong file is refused, not stored. */
export function looksLike(mediaType: string, bytes: Uint8Array): boolean {
  const at = (offset: number, text: string) => bytes.length >= offset + text.length && text.split("").every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
  switch (mediaType) {
    case "video/mp4": return at(4, "ftyp");
    case "audio/wav": return at(0, "RIFF") && at(8, "WAVE");
    case "audio/mpeg": return at(0, "ID3") || (bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "image/png": return bytes.length > 7 && bytes[0] === 0x89 && at(1, "PNG");
    case "image/jpeg": return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
    default: return false;
  }
}

export async function acceptMcpUpload(
  request: Request,
  token: string,
  deps: { getSql: () => Promise<Sql>; env: Record<string, string | undefined>; store?: (sql: Sql) => Promise<McpFileStore>; nowSeconds?: number },
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "PUT") return reply(405, { error: "Send the file with POST or PUT." });
  const secret = linkSecretFrom(deps.env);
  if (!secret) return reply(503, { error: "Upload links are not set up on this server (MEDIA_LINK_SECRET)." });
  const check = verifyUploadToken(token, secret, deps.nowSeconds ?? Math.floor(Date.now() / 1000));
  if (!check.ok) return check.reason === "expired" ? reply(410, { error: "This upload link has expired. Ask for a new one (meridian_upload_link)." }) : reply(403, { error: "This upload link is not valid." });
  const claims = check.claims;
  const sql = await deps.getSql();
  // A revoked or deleted connector's links stop working, whatever time is left on them.
  const connector = await sql<{ id: string }>`select id from mcp_connectors where id = ${claims.connectorId} and organization_id = ${claims.organizationId} and revoked_at is null limit 1`;
  if (!connector[0]) return reply(403, { error: "This upload link is not valid." });
  if (claims.projectId) {
    const project = await sql<{ id: string }>`select id from mcp_projects where id = ${claims.projectId} and organization_id = ${claims.organizationId} limit 1`;
    if (!project[0]) return reply(404, { error: "That video project is not in this workspace." });
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== claims.mediaType) return reply(415, { error: `This link takes ${claims.mediaType}. The request said ${type || "no content type"}.` });
  const bytes = await readLimited(request, claims.maxBytes);
  if (bytes === null) return reply(413, { error: `The file is larger than the ${Math.floor(claims.maxBytes / 1_048_576)} MB this link takes.` });
  if (bytes.byteLength === 0) return reply(400, { error: "The file is empty." });
  if (!looksLike(claims.mediaType, bytes)) return reply(422, { error: `That is not a ${claims.mediaType} file.` });
  try {
    const store = await (deps.store ?? meridianMcpFileStore)(sql);
    const file = await storeFile(sql, store, {
      organizationId: claims.organizationId, brandId: claims.brandId, connectorId: claims.connectorId, projectId: claims.projectId,
      kind: UPLOAD_MEDIA_TYPES[claims.mediaType], mediaType: claims.mediaType, bytes, costUsd: 0,
      details: { label: "Uploaded from a coding agent", source: "upload", sha256: createHash("sha256").update(bytes).digest("hex") },
    });
    return reply(201, { fileId: file.id, bytes: file.bytes, mediaType: file.mediaType });
  } catch {
    return reply(500, { error: "The file could not be stored. Nothing was saved." });
  }
}
