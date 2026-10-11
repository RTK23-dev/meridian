import assert from "node:assert/strict";
import test from "node:test";
import { pageUrlForSeed } from "./public-url.ts";

test("a seed names a page when it is an http(s) URL or a bare domain, and free text names none", () => {
  assert.equal(pageUrlForSeed("https://shop.example/sponge"), "https://shop.example/sponge");
  assert.equal(pageUrlForSeed("  http://shop.example  "), "http://shop.example/");
  assert.equal(pageUrlForSeed("shop.example/sponge"), "https://shop.example/sponge");
  assert.equal(pageUrlForSeed("shop.example"), "https://shop.example/");
  assert.equal(pageUrlForSeed("artisan sourdough"), null, "a phrase with spaces names no page");
  assert.equal(pageUrlForSeed("coffee"), null, "a single word without a dot names no page");
  assert.equal(pageUrlForSeed(""), null);
  assert.equal(pageUrlForSeed("   "), null);
});

test("a blocked page URL is still a page, so the crawl reports the block instead of treating it as free text", () => {
  assert.equal(pageUrlForSeed("http://127.0.0.1/admin"), "http://127.0.0.1/admin");
});
