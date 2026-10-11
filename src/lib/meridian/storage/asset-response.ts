import { createHash } from "node:crypto";
import type { Sql } from "../../db.ts";
import {
  canAccessStoredAsset,
  contentDispositionFor,
  framePosterStorageKey,
  isInActiveWorkspace,
  isNotModified,
  parseByteRange,
  pickActiveOrganization,
  storedBytesMatch,
  verifiedMediaMime,
} from "./media-access.ts";

/** The part of the artifact store the asset route reads. Production artifact bytes are fetched through it; Postgres locates them. */
export type ArtifactFileReader = { get(providerFileId: string): Promise<{ bytes: Uint8Array }> };

export type AssetRequest = {
  request: Request;
  assetId: string;
  /** The signed-in user, or null when there is none. A missing user is answered with 401 before anything is read. */
  userId: string | null;
  getSql: () => Promise<Sql>;
  loadArtifactFiles: () => Promise<ArtifactFileReader>;
  rateLimit: { allow(key: string, now: number): boolean };
  now?: () => number;
  logError?: (message: string, detail: string) => void;
};

/** Missing, unavailable and other-workspace assets all get this response, so existence is not revealed. */
const notFound = () => new Response("Not found", { status: 404 });

type StoredSource = {
  organizationId: string;
  brandId: string;
  mimeType: string;
  byteSize: number;
  sha256Hex: string;
  bytes: Uint8Array<ArrayBuffer>;
};

/**
 * Loads the stored bytes for one storage key within one workspace and brand. Studio, Hypit and creative-image writes land
 * in asset_blobs. Production artifacts land as bytes in the artifact store (Google Drive). Their storage_objects row in
 * Postgres locates them, so the bytes are read through that row when no blob exists. Call this only after the caller has been checked against the workspace.
 */
async function loadStoredSource(
  sql: Sql,
  loadArtifactFiles: AssetRequest["loadArtifactFiles"],
  scope: { storageKey: string; organizationId: string; brandId: string },
): Promise<StoredSource | null> {
  const blobs = await sql<Record<string, unknown>>`
    select organization_id, brand_id, body, mime_type, checksum, byte_size
    from asset_blobs
    where storage_key = ${scope.storageKey} and organization_id = ${scope.organizationId}
      and brand_id = ${scope.brandId} and lifecycle = 'stored'
    limit 1
  `;
  const blob = blobs[0];
  if (blob) {
    return {
      organizationId: String(blob.organization_id),
      brandId: String(blob.brand_id),
      mimeType: String(blob.mime_type ?? ""),
      byteSize: Number(blob.byte_size),
      sha256Hex: String(blob.checksum ?? ""),
      bytes: Buffer.from(String(blob.body ?? ""), "base64"),
    };
  }
  const objects = await sql<Record<string, unknown>>`
    select organization_id, brand_id, provider_file_id, mime_type, size_bytes, sha256
    from storage_objects
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and name = ${scope.storageKey}
    limit 1
  `;
  const object = objects[0];
  if (!object) return null;
  const file = await (await loadArtifactFiles()).get(String(object.provider_file_id));
  return {
    organizationId: String(object.organization_id),
    brandId: String(object.brand_id),
    mimeType: String(object.mime_type ?? ""),
    byteSize: Number(object.size_bytes),
    sha256Hex: String(object.sha256 ?? ""),
    bytes: new Uint8Array(file.bytes),
  };
}

/**
 * Serves one stored asset for a signed-in user: the rate limit, the workspace membership check, the stored bytes with
 * their checksum and MIME verified, and the HTTP answer (200, 206, 304, 404, 416, 429, 503). The route file supplies the
 * session, the database and the artifact store, so each answer can be tested without the auth stack.
 */
export async function serveStoredAsset(input: AssetRequest): Promise<Response> {
  const { request, assetId, userId } = input;
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const now = input.now ?? Date.now;
  if (!input.rateLimit.allow(userId, now())) return new Response("Too many asset requests", { status: 429, headers: { "Retry-After": "60" } });

  const sql = await input.getSql();
  const memberships = await sql<{ organization_id: string; role: string }>`
    select m.organization_id, m.role
    from memberships m
    join organizations o on o.id = m.organization_id
    where m.user_id = ${userId}
    order by o.created_at asc
  `;
  const preferences = await sql<{ active_organization_id: string | null }>`
    select active_organization_id from user_settings where user_id = ${userId} limit 1
  `;
  const active = pickActiveOrganization(
    preferences[0]?.active_organization_id,
    memberships.map((row) => ({ organizationId: String(row.organization_id), role: String(row.role) })),
  );
  if (!active) return notFound();

  const assets = await sql<Record<string, unknown>>`
    select a.organization_id, a.brand_id, a.storage_key
    from assets a
    join brands brand_scope on brand_scope.id = a.brand_id and brand_scope.organization_id = a.organization_id
      and brand_scope.deleted_at is null
    where a.id = ${assetId} and a.status = 'stored'
    limit 1
  `;
  const asset = assets[0];
  if (!asset) return notFound();
  const assetOrganizationId = String(asset.organization_id);
  const assetBrandId = String(asset.brand_id);
  if (!isInActiveWorkspace(assetOrganizationId, active)) return notFound();

  const url = new URL(request.url);
  // ?thumb=1 serves the stored still of a video. When no still exists the answer is 404, never a stand-in image.
  const wantsPoster = url.searchParams.get("thumb") === "1";
  const storageKey = wantsPoster ? framePosterStorageKey(String(asset.storage_key)) : String(asset.storage_key);

  let source: StoredSource | null;
  try {
    source = await loadStoredSource(sql, input.loadArtifactFiles, { storageKey, organizationId: assetOrganizationId, brandId: assetBrandId });
  } catch (error) {
    input.logError?.("[assets] stored bytes could not be read", error instanceof Error ? error.name : "unknown");
    return new Response("The stored file could not be read right now. Try again shortly.", { status: 503, headers: { "Retry-After": "30" } });
  }
  if (!source) return notFound();
  if (!canAccessStoredAsset({
    assetOrganizationId,
    blobOrganizationId: source.organizationId,
    assetBrandId,
    blobBrandId: source.brandId,
    memberOrganizationIds: [active.organizationId],
  })) return notFound();

  const bytes = source.bytes;
  const mime = verifiedMediaMime(bytes, source.mimeType);
  if (!mime) return notFound();
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  if (!storedBytesMatch({ byteLength: bytes.byteLength, sha256Hex }, { byteSize: source.byteSize, sha256Hex: source.sha256Hex })) {
    return new Response("Asset unavailable", { status: 404 });
  }

  const etag = `"${sha256Hex}"`;
  if (isNotModified(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=3600" } });
  }
  const headers = new Headers({
    "Content-Type": mime,
    "Content-Length": String(bytes.byteLength),
    ETag: etag,
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": contentDispositionFor({
      download: !wantsPoster && url.searchParams.get("download") === "1",
      assetId,
      mimeType: mime,
    }),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  // A poster is a single still, so it is always served whole. Only the video itself supports Range requests.
  if (wantsPoster) return new Response(bytes, { status: 200, headers });
  headers.set("Accept-Ranges", "bytes");
  // If-Range names the copy the client already has. When it no longer matches, the whole file is sent, as RFC 9110 asks.
  const ifRange = request.headers.get("if-range");
  const range = !ifRange || ifRange.trim() === etag ? parseByteRange(request.headers.get("range"), bytes.byteLength) : null;
  if (range === "invalid") {
    // A 416 has no body, so its Content-Length is zero. The full size is given only in Content-Range.
    headers.set("Content-Length", "0");
    headers.set("Content-Range", `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const partial = bytes.subarray(range.start, range.end + 1);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
    headers.set("Content-Length", String(partial.byteLength));
    return new Response(partial, { status: 206, headers });
  }
  return new Response(bytes, { status: 200, headers });
}
