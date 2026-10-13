/**
 * Signed, short-lived links to one approved creative file. Instagram and TikTok publish by fetching a media URL, so a live post
 * needs a URL their servers can read without a session. The link is an HMAC-SHA256 over the creative id and an expiry, made with
 * the server secret MEDIA_LINK_SECRET. It is valid for MEDIA_LINK_TTL_SECONDS after it is signed. The route that serves the file
 * (routes/api/media-links) checks the signature and the expiry before it reads anything.
 *
 * Nothing here calls a provider. It is pure: the secret and the public origin are read from the environment passed in, and the
 * clock is passed in too, so the tests are exact.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** A signed link is valid for this long after it is signed: 15 minutes. */
export const MEDIA_LINK_TTL_SECONDS = 15 * 60;

/** The secret must be at least this long. A shorter value is not used, so a weak secret never signs a link. */
const MIN_SECRET_LENGTH = 32;

/** Domain separation: a signature made for this purpose is not valid for any other HMAC use of the same secret. */
const SIGNING_LABEL = "meridian-media-link:v1";

export type MediaLinkCheck = "ok" | "malformed" | "bad_signature" | "expired";

function signatureOf(secret: string, creativeId: string, expires: number): string {
  return createHmac("sha256", secret).update(`${SIGNING_LABEL}\n${creativeId}\n${expires}`).digest("hex");
}

/** The expiry (Unix seconds) and the signature for one creative. The caller puts both in the URL. */
export function signMediaLink(input: { creativeId: string; nowSeconds: number; secret: string }): { expires: number; sig: string } {
  const expires = input.nowSeconds + MEDIA_LINK_TTL_SECONDS;
  return { expires, sig: signatureOf(input.secret, input.creativeId, expires) };
}

/**
 * Checks a link. The signature is checked first, so an expired link that was never signed is a bad signature, not an expiry. A
 * link whose expiry has passed (not before) is expired. Anything that is not the expected shape is malformed.
 */
export function verifyMediaLink(input: {
  creativeId: string;
  expires: string | null;
  sig: string | null;
  secret: string;
  nowSeconds: number;
}): MediaLinkCheck {
  if (!input.creativeId || !input.expires || !input.sig) return "malformed";
  if (!/^\d{1,12}$/.test(input.expires) || !/^[0-9a-f]{64}$/.test(input.sig)) return "malformed";
  const expires = Number(input.expires);
  const expected = Buffer.from(signatureOf(input.secret, input.creativeId, expires), "hex");
  const given = Buffer.from(input.sig, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "bad_signature";
  if (input.nowSeconds >= expires) return "expired";
  return "ok";
}

/** The signing secret, or null when it is unset or too short. Read only from the environment passed in. */
export function mediaLinkSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.MEDIA_LINK_SECRET ?? "").trim();
  return value.length >= MIN_SECRET_LENGTH ? value : null;
}

/**
 * The public origin the platforms fetch from: APP_URL, else PUBLIC_APP_URL. It must be an https origin with no path, so a
 * localhost or http address is never handed to a platform that cannot reach it. Null when neither is usable.
 */
export function publicMediaOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const raw of [env.APP_URL, env.PUBLIC_APP_URL]) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }
  return null;
}

/** The full signed URL for one creative. The query holds only the expiry and the signature, both ASCII. */
export function signedMediaUrl(input: { origin: string; creativeId: string; expires: number; sig: string }): string {
  return `${input.origin}/api/media-links/${encodeURIComponent(input.creativeId)}?expires=${input.expires}&sig=${input.sig}`;
}

/** The hostnames TikTok has verified for this app, from TIKTOK_VERIFIED_MEDIA_DOMAINS. Entries that are not bare hostnames are dropped. */
export function tiktokVerifiedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TIKTOK_VERIFIED_MEDIA_DOMAINS ?? "";
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(item));
}

/** True when the URL's host is a verified domain or a subdomain of one. TikTok covers subdomains of a verified domain. */
export function hostIsVerified(url: string, verifiedDomains: readonly string[]): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return verifiedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The state of the signed-link delivery for one platform. Not ready carries the reason, which never includes the secret. */
export type MediaDelivery =
  | { ready: true; origin: string; secret: string; verifiedDomains: string[] }
  | { ready: false; reason: string };

/**
 * Whether a platform can receive a signed link now. A missing secret, a missing public origin, or (for TikTok) an origin host that
 * is not a verified domain is not ready, and the reason says what to set. Nothing is sent when it is not ready.
 */
export function mediaDeliveryFor(platform: "instagram" | "tiktok", env: NodeJS.ProcessEnv = process.env): MediaDelivery {
  const label = platform === "instagram" ? "Instagram" : "TikTok";
  const secret = mediaLinkSecret(env);
  if (!secret) {
    return { ready: false, reason: `${label} fetches the video from a signed link, and MEDIA_LINK_SECRET is not set to at least ${MIN_SECRET_LENGTH} characters on the server. Nothing was sent.` };
  }
  const origin = publicMediaOrigin(env);
  if (!origin) {
    return { ready: false, reason: `${label} fetches the video from a signed link, and no public https origin is set (APP_URL or PUBLIC_APP_URL). Nothing was sent.` };
  }
  const verifiedDomains = tiktokVerifiedDomains(env);
  if (platform === "tiktok") {
    if (verifiedDomains.length === 0) {
      return { ready: false, reason: "TikTok pulls the video only from a domain verified for this app, and TIKTOK_VERIFIED_MEDIA_DOMAINS lists none. Nothing was sent." };
    }
    if (!hostIsVerified(origin, verifiedDomains)) {
      return { ready: false, reason: `The media host of this deployment is not in TIKTOK_VERIFIED_MEDIA_DOMAINS, so TikTok would refuse the pull. Nothing was sent.` };
    }
  }
  return { ready: true, origin, secret, verifiedDomains };
}
