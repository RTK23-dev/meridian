import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { DEV_USER_ID, authConfigured } from "@/lib/auth/verify.server";
import { gateIdentityEnabled } from "@/lib/auth/gate-identity.server";
import {
  canAccessStoredAsset,
  isInActiveWorkspace,
  parseByteRange,
  pickActiveOrganization,
  storedBytesMatch,
  verifiedMediaMime,
} from "@/lib/meridian/storage/media-access";
import { createRateLimit } from "@/lib/meridian/security/limits";

const assetReadLimit = createRateLimit(120, 60_000);

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
 * in asset_blobs. Production artifacts land in the artifact store (Google Drive), indexed by storage_objects, so that is
 * read when no blob exists. Call this only after the caller has been checked against the workspace.
 */
async function loadStoredSource(
  sql: Sql,
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
  const { defaultArtifactDrive } = await import("@/lib/meridian/storage/artifact-drive");
  const file = await defaultArtifactDrive().get(String(object.provider_file_id));
  return {
    organizationId: String(object.organization_id),
    brandId: String(object.brand_id),
    mimeType: String(object.mime_type ?? ""),
    byteSize: Number(object.size_bytes),
    sha256Hex: String(object.sha256 ?? ""),
    bytes: new Uint8Array(file.bytes),
  };
}

export const Route = createFileRoute("/api/assets/$assetId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        const devFallbackAllowed = !authConfigured && !gateIdentityEnabled() && !process.env.DATABASE_URL?.trim();
        const userId = session?.user?.id ?? (devFallbackAllowed ? DEV_USER_ID : "");
        if (!userId) return new Response("Unauthorized", { status: 401 });
        if (!assetReadLimit.allow(userId, Date.now())) return new Response("Too many asset requests", { status: 429, headers: { "Retry-After": "60" } });

        const sql = await getSql();
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
          where a.id = ${params.assetId} and a.status = 'stored'
          limit 1
        `;
        const asset = assets[0];
        if (!asset) return notFound();
        const assetOrganizationId = String(asset.organization_id);
        const assetBrandId = String(asset.brand_id);
        if (!isInActiveWorkspace(assetOrganizationId, active)) return notFound();

        let source: StoredSource | null;
        try {
          source = await loadStoredSource(sql, { storageKey: String(asset.storage_key), organizationId: assetOrganizationId, brandId: assetBrandId });
        } catch (error) {
          console.error("[assets] stored bytes could not be read", error instanceof Error ? error.name : "unknown");
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

        const headers = new Headers({
          "Content-Type": mime,
          "Content-Length": String(bytes.byteLength),
          ETag: `"${sha256Hex}"`,
          "Cache-Control": "private, max-age=3600",
          "Content-Disposition": new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Accept-Ranges": "bytes",
        });
        const range = parseByteRange(request.headers.get("range"), bytes.byteLength);
        if (range === "invalid") {
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
      },
    },
  },
});
