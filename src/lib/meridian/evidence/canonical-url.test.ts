import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateEvidence, normalizeCanonicalUrl } from "./dedupe.ts";

test("distinct products on one path keep distinct canonical URLs", () => {
  // The resource is named by its query. Dropping it merged every product on the page into one.
  assert.notEqual(
    normalizeCanonicalUrl("https://shop.example/product?id=1"),
    normalizeCanonicalUrl("https://shop.example/product?id=2"),
  );
  assert.equal(normalizeCanonicalUrl("https://shop.example/product?id=1"), "https://shop.example/product?id=1");
});

test("the same page reached through tracking parameters is one canonical URL", () => {
  assert.equal(
    normalizeCanonicalUrl("https://shop.example/product?id=1&utm_source=x&fbclid=abc#reviews"),
    normalizeCanonicalUrl("https://shop.example/product?id=1"),
  );
});

test("query parameters are ordered, so their order does not create a second source", () => {
  assert.equal(
    normalizeCanonicalUrl("https://shop.example/p?b=2&a=1"),
    normalizeCanonicalUrl("https://shop.example/p?a=1&b=2"),
  );
});

test("http and https reach the same canonical URL, and default ports are dropped", () => {
  assert.equal(normalizeCanonicalUrl("http://example.com/a"), normalizeCanonicalUrl("https://example.com/a"));
  assert.equal(normalizeCanonicalUrl("http://example.com:80/a"), "https://example.com/a");
  assert.equal(normalizeCanonicalUrl("https://example.com:443/a"), "https://example.com/a");
});

test("a non-default port is kept, because it names a different server", () => {
  assert.equal(normalizeCanonicalUrl("https://example.com:8443/a"), "https://example.com:8443/a");
});

test("trailing slashes are removed, but the root keeps no path", () => {
  assert.equal(normalizeCanonicalUrl("https://example.com/a/"), normalizeCanonicalUrl("https://example.com/a"));
  assert.equal(normalizeCanonicalUrl("https://example.com/"), "https://example.com");
});

test("www stays distinct, because two hosts can serve different sites", () => {
  assert.notEqual(normalizeCanonicalUrl("https://www.example.com/a"), normalizeCanonicalUrl("https://example.com/a"));
});

test("path case is kept, because it can name different resources", () => {
  assert.notEqual(normalizeCanonicalUrl("https://example.com/Product"), normalizeCanonicalUrl("https://example.com/product"));
});

test("empty and whitespace input yield no canonical URL, and non-URL text is compared trimmed and lower-cased", () => {
  assert.equal(normalizeCanonicalUrl(null), null);
  assert.equal(normalizeCanonicalUrl("   "), null);
  assert.equal(normalizeCanonicalUrl("  Kitchen Sponge "), "kitchen sponge");
});

test("the duplicate check does not report two distinct products as one", () => {
  const match = findDuplicateEvidence(
    { id: "new", canonicalUrl: "https://shop.example/product?id=2" },
    [{ id: "old", canonicalUrl: "https://shop.example/product?id=1" }],
  );
  assert.equal(match.isDuplicate, false);
});
