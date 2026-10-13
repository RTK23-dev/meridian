/**
 * Serves one approved creative file through a signed link (media-link.ts). The platforms that publish by URL (Instagram's container
 * and TikTok's PULL_FROM_URL) fetch it with no session, so this answer is the only check. The order is fixed: the secret, then the
 * signature and the expiry, then the database. A link that does not verify reads nothing. A verified link serves the file only when
 * the creative is approved or in testing (the same rule the publish path uses), its brand is live, and the stored bytes match their
 * MIME type.
 *
 * The URL and the token are never logged. Errors name only the failure kind.
 */
import type { Sql } from "../../db.ts";
import { loadStoredSource, type ArtifactFileReader } from "./asset-response.ts";
import { verifiedMediaMime } from "./media-access.ts";
import { mediaLinkSecret, verifyMediaLink } from "./media-link.ts";

export type SignedCreativeRequest = {
  request: Request;
  creativeId: string;
  getSql: () => Promise<Sql>;
  loadArtifactFiles: () => Promise<ArtifactFileReader>;
  nowSeconds?: () => number;
  /** Receives the failure kind only. It never receives the URL, the token or the bytes. */
  logError?: (message: string, detail: string) => void;
  /** Read only in tests. Production reads MEDIA_LINK_SECRET from the environment. */
  secret?: string | null;
};

const notFound = () => new Response("Not found", { status: 404 });

const refused = (message: string) =>
  new Response(message, { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function serveSignedCreative(input: SignedCreativeRequest): Promise<Response> {
  const secret = input.secret === undefined ? mediaLinkSecret() : input.secret;
  // No secret means no link can verify, so the route answers as if nothing exists.
  if (!secret) return notFound();

  const url = new URL(input.request.url);
  const nowSeconds = input.nowSeconds ? input.nowSeconds() : Math.floor(Date.now() / 1000);
  const check = verifyMediaLink({
    creativeId: input.creativeId,
    expires: url.searchParams.get("expires"),
    sig: url.searchParams.get("sig"),
    secret,
    nowSeconds,
  });
  if (check === "expired") return refused("This link has expired. Ask for a new one.");
  if (check !== "ok") return refused("This link is not valid.");

  const sql = await input.getSql();
  // The creative must still be approved or in testing, and its brand live. A link outlives a rejection by at most its 15 minutes,
  // and this check ends it at once.
  const creatives = await sql<{ organization_id: string; brand_id: string }>`
    select c.organization_id, c.brand_id
    from creative_records c
    join brands b on b.id = c.brand_id and b.organization_id = c.organization_id and b.deleted_at is null
    where c.id = ${input.creativeId} and c.status in ('approved', 'testing')
    limit 1
  `;
  const creative = creatives[0];
  if (!creative) return notFound();

  // The same asset the publish path reads: the newest one that belongs to the creative.
  const assets = await sql<{ storage_key: string; mime_type: string }>`
    select storage_key, mime_type from assets
    where creative_id = ${input.creativeId} and organization_id = ${creative.organization_id}
    order by created_at desc limit 1
  `;
  const asset = assets[0];
  if (!asset) return notFound();

  let source;
  try {
    source = await loadStoredSource(sql, input.loadArtifactFiles, {
      storageKey: asset.storage_key,
      organizationId: creative.organization_id,
      brandId: creative.brand_id,
    });
  } catch (error) {
    input.logError?.("[media-links] stored bytes could not be read", error instanceof Error ? error.name : "unknown");
    return new Response("The stored file could not be read right now. Try again shortly.", { status: 503, headers: { "Retry-After": "30" } });
  }
  if (!source) return notFound();
  const mime = verifiedMediaMime(source.bytes, source.mimeType);
  if (!mime) return notFound();

  return new Response(source.bytes, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(source.bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
