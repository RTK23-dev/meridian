/**
 * Signed, 15-minute links to one engine object for a provider that fetches its input by URL: Shotstack fetches the sources of a
 * component-free EDL (Bible 6.11, owner decision 2026-10-14), and a chain's keyframe and clip read their references and first frame
 * the same way (Bible 10.1). The engine never reads the environment: it takes a MediaLinkSigner (the port in
 * src/engine/jobs/media-link.ts), and this file is the Meridian implementation that the production runtime passes in.
 *
 * Two kinds of object can be linked, each for its own organization only:
 *   - an engine media object (a take, a voice file, a rendered video): engine/{org}/{requestId}/{stage}/{artifactId}.{mp4|wav|png};
 *   - a kit image (Bible 13), the character sheet, persona portrait or product image a page's kit names:
 *     kits/{org}/{brand}/{kind}/{kitId}/{name}.png, where kind is character, persona or product. The brand is in the key because the
 *     store keys an object by organization, brand and name, so the route reads the object under the brand its key names.
 *
 * The link is an HMAC-SHA256 over a domain label, the organization, the object key and the expiry, made with MEDIA_LINK_SECRET (the
 * same server secret as the creative links, media-link.ts, but a different label, so a creative link never verifies here and the
 * reverse). The route (routes/api/engine-media.ts, serveEngineMedia here) checks the signature and the expiry before it reads
 * anything, then reads the object only for the organization the link names: an engine object only from the request that owns the key,
 * a kit image only under its own organization and brand.
 *
 * Fail closed: without MEDIA_LINK_SECRET (at least 32 characters) or a public https origin (APP_URL or PUBLIC_APP_URL), the signer
 * answers not_connected with the reason, and nothing is signed. The route answers as if nothing exists when the secret is unset.
 *
 * Nothing here calls a provider. The URL and the token are never logged.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sql } from "../../db.ts";
import { createGoogleDriveObjectStore, createSqlStorageMetadataRepository } from "./object-store.ts";
import { MEDIA_LINK_TTL_SECONDS, mediaLinkSecret, publicMediaOrigin } from "./media-link.ts";

/** The path the route serves. A signed link is built on this path under the public origin. */
export const ENGINE_MEDIA_PATH = "/api/engine-media";

/** Domain separation from the creative links (media-link.ts): a signature for one purpose is not valid for the other. */
const SIGNING_LABEL = "meridian-engine-media-link:v1";

/** One path part of an engine key (the same rule as the engine's artifact store). */
const SAFE_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The engine's media extensions and the MIME type each one is served as. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = { mp4: "video/mp4", wav: "audio/wav", png: "image/png" };

/**
 * The kit-store prefix (Bible 13). A kit image is a png under its organization, its brand, the kind of kit it belongs to (only the kinds
 * that carry images: a character sheet, a persona's portraits, a product's images) and the kit's id. Kit images are png in this rule;
 * other image types are refused until the owner decides them (jobs/STATUS.md).
 */
const KIT_KEY = /^kits\/([^/]+)\/([^/]+)\/(character|persona|product)\/([^/]+)\/([^/]+)\.png$/;

const MIN_SECRET_REASON = "MEDIA_LINK_SECRET is not set to at least 32 characters on the server";

export type EngineMediaLinkResult =
  | { status: "ok"; url: string; expires: number }
  | { status: "not_connected"; reason: string }
  /** The object is not a linkable object of the organization: nothing is signed (a refusal of the input, not a fault). */
  | { status: "refused"; reason: string };

/** The Meridian signer's shape. It is structurally the engine's MediaLinkSigner, so the engine never imports this file. */
export type EngineMediaLinkSigner = {
  sign(organizationId: string, objectKey: string, ttlSeconds: number): Promise<EngineMediaLinkResult>;
};

/** The object store the route and the engine share: Meridian's Drive-backed store (artifact-store.ts). */
export type EngineObjectStore = {
  get(organizationId: string, brandId: string, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
};

export type MediaLinkCheck = "ok" | "malformed" | "bad_signature" | "expired";

/** Whether a key is an engine media key for this organization: engine/{org}/{requestId}/{stage}/{artifactId}.{ext}. */
export function isEngineMediaKey(organizationId: string, key: string): boolean {
  const match = /^engine\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.(mp4|wav|png)$/.exec(key);
  if (!match) return false;
  const parts = [match[1], match[2], match[3], match[4]];
  return organizationId === match[1] && parts.every((part) => part !== undefined && SAFE_PART.test(part) && !part.includes(".."));
}

export type KitKeyParts = { organizationId: string; brandId: string; kind: string; kitId: string; name: string };

/** The parts of a kit-store key, or null when the key is not one. Every part passes the path rule the engine's keys pass. */
export function kitKeyParts(key: string): KitKeyParts | null {
  const match = KIT_KEY.exec(key);
  if (!match) return null;
  const [, organizationId, brandId, kind, kitId, name] = match;
  if (organizationId === undefined || brandId === undefined || kind === undefined || kitId === undefined || name === undefined) return null;
  const parts = [organizationId, brandId, kitId, name];
  if (!parts.every((part) => SAFE_PART.test(part) && !part.includes(".."))) return null;
  return { organizationId, brandId, kind, kitId, name };
}

/** Whether a key is a kit image of this organization (its key names the organization, and no other). */
export function isKitMediaKey(organizationId: string, key: string): boolean {
  const parts = kitKeyParts(key);
  return parts !== null && parts.organizationId === organizationId;
}

/** Whether the signer may link an object: an engine media object or a kit image, of this organization only. */
export function isLinkableMediaKey(organizationId: string, key: string): boolean {
  return isEngineMediaKey(organizationId, key) || isKitMediaKey(organizationId, key);
}

function signatureOf(secret: string, organizationId: string, objectKey: string, expires: number): string {
  return createHmac("sha256", secret).update(`${SIGNING_LABEL}\n${organizationId}\n${objectKey}\n${expires}`).digest("hex");
}

/** Checks a link's signature and expiry. The signature is checked first, so an expired link that was never signed is a bad signature. */
export function verifyEngineMediaLink(input: {
  organizationId: string;
  objectKey: string;
  expires: string | null;
  sig: string | null;
  secret: string;
  nowSeconds: number;
}): MediaLinkCheck {
  if (!input.organizationId || !input.objectKey || !input.expires || !input.sig) return "malformed";
  if (!/^\d{1,12}$/.test(input.expires) || !/^[0-9a-f]{64}$/.test(input.sig)) return "malformed";
  const expires = Number(input.expires);
  const expected = Buffer.from(signatureOf(input.secret, input.organizationId, input.objectKey, expires), "hex");
  const given = Buffer.from(input.sig, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "bad_signature";
  if (input.nowSeconds >= expires) return "expired";
  return "ok";
}

export type EngineMediaLinkOptions = {
  /** Reads the signing secret. Default: the creative links' secret from the environment (media-link.ts). */
  secret?: () => string | null;
  /** Reads the public https origin. Default: APP_URL or PUBLIC_APP_URL (media-link.ts). */
  origin?: () => string | null;
  nowSeconds?: () => number;
};

/**
 * The Meridian signer the engine's production runtime passes in. A missing secret or origin is not_connected with its reason. The
 * caller's ttl may not exceed the 15 minutes of the link policy (media-link.ts); a ttl outside that range is a programming error and
 * throws. A key that is not an engine media object or a kit image of the organization is refused before anything is signed, so a kit
 * image of another organization is never linked.
 */
export function engineMediaLinkSigner(options: EngineMediaLinkOptions = {}): EngineMediaLinkSigner {
  const secretOf = options.secret ?? (() => mediaLinkSecret());
  const originOf = options.origin ?? (() => publicMediaOrigin());
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return {
    async sign(organizationId, objectKey, ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MEDIA_LINK_TTL_SECONDS) {
        throw new Error(`engine media links last 1 to ${MEDIA_LINK_TTL_SECONDS} seconds`);
      }
      if (!isLinkableMediaKey(organizationId, objectKey)) {
        return {
          status: "refused",
          reason: "the object is not an engine media object or a kit image of this organization. Nothing was signed.",
        };
      }
      const secret = secretOf();
      if (!secret) {
        return { status: "not_connected", reason: `A signed media link cannot be made: ${MIN_SECRET_REASON}. Nothing was sent.` };
      }
      const origin = originOf();
      if (!origin) {
        return {
          status: "not_connected",
          reason: "A signed media link cannot be made: no public https origin is set (APP_URL or PUBLIC_APP_URL). Nothing was sent.",
        };
      }
      const expires = nowSeconds() + ttlSeconds;
      const query = new URLSearchParams({
        org: organizationId,
        key: objectKey,
        expires: String(expires),
        sig: signatureOf(secret, organizationId, objectKey, expires),
      });
      return { status: "ok", url: `${origin}${ENGINE_MEDIA_PATH}?${query.toString()}`, expires };
    },
  };
}

/** Meridian's object store for engine media: the Drive-backed store, indexed by Postgres (storage_objects). */
export function engineObjectStore(sql: Sql) {
  return createGoogleDriveObjectStore(undefined, { metadataRepo: createSqlStorageMetadataRepository(sql) });
}

export type ServeEngineMediaInput = {
  request: Request;
  getSql: () => Promise<Sql>;
  /** Builds the object store for this request's database. */
  objectStore: (sql: Sql) => EngineObjectStore;
  /** Read only in tests. Production reads MEDIA_LINK_SECRET from the environment. */
  secret?: string | null;
  nowSeconds?: () => number;
  /** Receives the failure kind only. It never receives the URL, the token or the bytes. */
  logError?: (message: string, detail: string) => void;
};

const notFound = () => new Response("Not found", { status: 404 });
const refused = (message: string) =>
  new Response(message, { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/**
 * The brand a linked object is stored under, or null when none is found. A kit image names its brand in its key: the store is keyed
 * by organization, brand and name, so a brand of another organization finds nothing. An engine object's brand is the brand of the
 * request that owns its key, in the organization the link names.
 */
async function brandOfLinkedKey(sql: Sql, organizationId: string, objectKey: string): Promise<string | null> {
  const kit = kitKeyParts(objectKey);
  if (kit !== null) return kit.brandId;
  const requestId = objectKey.split("/")[2] ?? "";
  const rows = await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  return rows[0]?.brand_id ?? null;
}

/**
 * Serves one linked object (an engine media object or a kit image) through a signed link. The order is fixed: the secret, then the
 * link (its shape, its signature and its expiry), then the database (the request that owns an engine key, in the organization the
 * link names; the brand a kit key names), then the object. A link that does not verify reads nothing.
 */
export async function serveEngineMedia(input: ServeEngineMediaInput): Promise<Response> {
  const secret = input.secret === undefined ? mediaLinkSecret() : input.secret;
  if (!secret) return notFound();

  const url = new URL(input.request.url);
  const organizationId = url.searchParams.get("org") ?? "";
  const objectKey = url.searchParams.get("key") ?? "";
  if (!isLinkableMediaKey(organizationId, objectKey)) return refused("This link is not valid.");
  const nowSeconds = input.nowSeconds ? input.nowSeconds() : Math.floor(Date.now() / 1000);
  const check = verifyEngineMediaLink({
    organizationId,
    objectKey,
    expires: url.searchParams.get("expires"),
    sig: url.searchParams.get("sig"),
    secret,
    nowSeconds,
  });
  if (check === "expired") return refused("This link has expired. Ask for a new one.");
  if (check !== "ok") return refused("This link is not valid.");

  const sql = await input.getSql();
  const brandId = await brandOfLinkedKey(sql, organizationId, objectKey);
  if (brandId === null) return notFound();

  let object;
  try {
    object = await input.objectStore(sql).get(organizationId, brandId, objectKey);
  } catch (error) {
    input.logError?.("[engine-media] stored bytes could not be read", error instanceof Error ? error.name : "unknown");
    return new Response("The stored file could not be read right now. Try again shortly.", { status: 503, headers: { "Retry-After": "30" } });
  }
  if (!object) return notFound();
  const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1);
  if (MIME_BY_EXTENSION[extension] !== object.mimeType) return notFound();

  return new Response(new Uint8Array(object.bytes), {
    status: 200,
    headers: {
      "Content-Type": object.mimeType,
      "Content-Length": String(object.bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
