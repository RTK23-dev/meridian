/**
 * Shopify's webhook signature. Each HTTPS delivery carries X-Shopify-Hmac-Sha256: the base64 of HMAC-SHA256 over the raw request
 * body, keyed with the app's client secret. The digest is compared as decoded bytes, in constant time.
 *
 * Sources (retrieved 2026-10-15):
 *   https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 *   https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The base64 HMAC-SHA256 Shopify would send for this body and secret. */
export function shopifyHmacOf(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export type ShopifyHmacDecision = { ok: true } | { ok: false; reason: string };

/**
 * Accepts only a header that is valid base64 and decodes to the same 32 bytes as the digest of the body. A missing secret, a
 * missing or malformed header, and a mismatch are each refused, so no delivery passes on a blank value.
 */
export function verifyShopifyHmac(input: { rawBody: string; header: string; secret: string }): ShopifyHmacDecision {
  if (!input.secret.trim()) return { ok: false, reason: "No Shopify secret is configured." };
  const presented = input.header.trim();
  if (!presented || presented.length % 4 !== 0 || !BASE64.test(presented)) {
    return { ok: false, reason: "The HMAC header is missing or is not base64." };
  }
  const expected = Buffer.from(shopifyHmacOf(input.rawBody, input.secret), "base64");
  const received = Buffer.from(presented, "base64");
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "The HMAC does not match the body." };
  }
  return { ok: true };
}
