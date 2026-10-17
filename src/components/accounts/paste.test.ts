import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountPaste } from "./paste.ts";

test("a profile link becomes the handle and the account id", () => {
  assert.deepEqual(parseAccountPaste("https://www.instagram.com/acme/"), {
    externalAccountId: "acme",
    handle: "@acme",
    name: "acme",
  });
  assert.deepEqual(parseAccountPaste("https://www.youtube.com/@BrandShorts"), {
    externalAccountId: "BrandShorts",
    handle: "@BrandShorts",
    name: "BrandShorts",
  });
  assert.equal(parseAccountPaste("https://www.tiktok.com/@brand")?.externalAccountId, "brand");
  assert.equal(parseAccountPaste("https://facebook.com/BrandPage")?.externalAccountId, "BrandPage");
});

test("an @handle or a bare ad account id is enough", () => {
  assert.equal(parseAccountPaste("@studio")?.externalAccountId, "studio");
  assert.equal(parseAccountPaste("act_123456")?.externalAccountId, "act_123456");
  assert.equal(parseAccountPaste("act_123456")?.handle, "");
});

test("a content link is not stored as the account, and a profile link keeps the profile", () => {
  assert.equal(parseAccountPaste("https://facebook.com/profile.php?id=1000123")?.externalAccountId, "1000123");
  assert.equal(parseAccountPaste("https://facebook.com/profile.php"), null);
  assert.equal(parseAccountPaste("https://www.tiktok.com/@brand/video/7300000000")?.externalAccountId, "brand");
  assert.equal(parseAccountPaste("https://www.instagram.com/brand/reels/")?.externalAccountId, "brand");
  assert.equal(parseAccountPaste("https://www.instagram.com/reels/"), null);
  assert.equal(parseAccountPaste("https://www.youtube.com/watch?v=abc"), null);
  assert.equal(parseAccountPaste("https://www.youtube.com/shorts/abc"), null);
  assert.equal(parseAccountPaste("https://www.youtube.com/channel/UCbrand")?.externalAccountId, "UCbrand");
});

test("a bare domain or a blank paste is not an account", () => {
  assert.equal(parseAccountPaste("https://instagram.com"), null);
  assert.equal(parseAccountPaste("instagram.com"), null);
  assert.equal(parseAccountPaste("  "), null);
  assert.equal(parseAccountPaste(""), null);
});
