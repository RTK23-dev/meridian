import assert from "node:assert/strict";
import test from "node:test";
import { shopifyHmacOf, verifyShopifyHmac } from "./verify.ts";

// Recorded fixture. The digest was computed once with the documented algorithm (HMAC-SHA256 over the raw body, keyed with the
// secret, base64 encoded): printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64
const SECRET = "shpss_fixture_secret";
const BODY = '{"id":450789469,"name":"#1001","currency":"USD","total_price":"409.94"}';
const HEADER = "YAzlXwo7hAUL1rjdIjrMxyDjL80T4tCVUOOv6ZAYwbA=";

test("the digest of the recorded body matches the recorded header", () => {
  assert.equal(shopifyHmacOf(BODY, SECRET), HEADER);
});

test("a delivery with the matching header is accepted", () => {
  assert.deepEqual(verifyShopifyHmac({ rawBody: BODY, header: HEADER, secret: SECRET }), { ok: true });
});

test("a body changed by one character is refused", () => {
  const changed = BODY.replace("409.94", "409.95");
  const decision = verifyShopifyHmac({ rawBody: changed, header: HEADER, secret: SECRET });
  assert.equal(decision.ok, false);
});

test("a different secret is refused", () => {
  const decision = verifyShopifyHmac({ rawBody: BODY, header: HEADER, secret: "another_secret" });
  assert.deepEqual(decision, { ok: false, reason: "The HMAC does not match the body." });
});

test("an empty secret is refused, so no delivery passes on a blank key", () => {
  const decision = verifyShopifyHmac({ rawBody: BODY, header: HEADER, secret: "   " });
  assert.deepEqual(decision, { ok: false, reason: "No Shopify secret is configured." });
});

test("a missing header and a header that is not base64 are refused", () => {
  assert.equal(verifyShopifyHmac({ rawBody: BODY, header: "", secret: SECRET }).ok, false);
  assert.equal(verifyShopifyHmac({ rawBody: BODY, header: "not base64!!", secret: SECRET }).ok, false);
  // Hex is valid characters but the wrong length and encoding, so it cannot match the 32 decoded bytes.
  assert.equal(verifyShopifyHmac({ rawBody: BODY, header: "a".repeat(64), secret: SECRET }).ok, false);
});
