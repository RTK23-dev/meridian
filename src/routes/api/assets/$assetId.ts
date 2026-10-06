import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { DEV_USER_ID, authConfigured } from "@/lib/auth/verify.server";
import { gateIdentityEnabled } from "@/lib/auth/gate-identity.server";
import { canAccessStoredAsset, isPreviewableMime, parseByteRange } from "@/lib/meridian/storage/media-access";
import { createRateLimit } from "@/lib/meridian/security/limits";

const assetReadLimit = createRateLimit(120, 60_000);

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
        const rows = await sql<Record<string, unknown>>`
          select a.organization_id as asset_organization_id, a.brand_id as asset_brand_id,
                 a.storage_key, b.organization_id as blob_organization_id, b.brand_id as blob_brand_id,
                 b.body, b.mime_type, b.checksum, b.byte_size
          from assets a
          join brands brand_scope on brand_scope.id = a.brand_id and brand_scope.organization_id = a.organization_id
          join asset_blobs b on b.storage_key = a.storage_key
            and b.organization_id = brand_scope.organization_id and b.brand_id = brand_scope.id
          where a.id = ${params.assetId} and b.lifecycle = 'stored'
          limit 1
        `;
        const row = rows[0];
        if (!row) return new Response("Not found", { status: 404 });
        const members = await sql<{ organization_id: string }>`
          select organization_id from memberships where user_id = ${userId}
        `;
        const memberOrganizationIds = members.map((member) => String(member.organization_id));
        if (!canAccessStoredAsset({
          assetOrganizationId: String(row.asset_organization_id),
          blobOrganizationId: String(row.blob_organization_id),
          assetBrandId: String(row.asset_brand_id),
          blobBrandId: String(row.blob_brand_id),
          memberOrganizationIds,
        })) return new Response("Not found", { status: 404 });

        const mime = String(row.mime_type ?? "").toLowerCase();
        if (!isPreviewableMime(mime)) return new Response("Not found", { status: 404 });
        const bytes = Buffer.from(String(row.body ?? ""), "base64");
        if (bytes.byteLength !== Number(row.byte_size) || createHash("sha256").update(bytes).digest("hex") !== String(row.checksum)) {
          return new Response("Asset unavailable", { status: 404 });
        }
        const headers = new Headers({
          "Content-Type": mime,
          "Content-Length": String(bytes.byteLength),
          ETag: `"${String(row.checksum)}"`,
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
