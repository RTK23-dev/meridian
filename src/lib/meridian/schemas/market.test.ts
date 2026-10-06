import assert from "node:assert/strict";
import test from "node:test";
import { competitorFieldsSchema, publicPageSchema, researchCollectionSchema } from "./market.ts";

test("market forms trim values, normalize public URLs, and uppercase country codes", () => {
  assert.deepEqual(researchCollectionSchema.parse({ searchTerms: "  soap  ", country: "us", limit: "50" }), { searchTerms: "soap", country: "US", limit: 50 });
  assert.equal(competitorFieldsSchema.parse({ name: " Foam Co ", website: "foam.example", notes: " ", kind: "direct" }).website, "https://foam.example/");
  assert.equal(publicPageSchema.parse({ url: "example.test/about" }).url, "https://example.test/about");
});

test("market forms reject blank, overlong, unsafe, and out-of-range values", () => {
  assert.equal(researchCollectionSchema.safeParse({ searchTerms: " ", country: "USA", limit: 200 }).success, false);
  assert.equal(competitorFieldsSchema.safeParse({ name: " ", website: "javascript:alert(1)", kind: "direct" }).success, false);
  assert.equal(publicPageSchema.safeParse({ url: "javascript:alert(1)" }).success, false);
});

test("optional market API fields retain the server's null-as-empty behavior", () => {
  assert.equal(competitorFieldsSchema.parse({ name: "Shop", website: null, notes: null, kind: "direct" }).website, "");
  assert.equal(publicPageSchema.safeParse({ url: null }).success, false);
});
