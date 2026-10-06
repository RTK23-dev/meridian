import assert from "node:assert/strict";
import test from "node:test";
import { brandIdentitySchema, newBrandSchema } from "./brand.ts";

test("brand identity trims input and normalizes a bare website", () => {
  const result = brandIdentitySchema.parse({ name: "  Meridian Soap  ", website: "example.test", sells: " soap " });
  assert.equal(result.name, "Meridian Soap");
  assert.equal(result.website, "https://example.test/");
  assert.equal(result.sells, "soap");
});

test("new-brand input requires what the brand sells and rejects unsafe website protocols", () => {
  assert.equal(newBrandSchema.safeParse({ name: "Brand" }).success, false);
  assert.equal(newBrandSchema.safeParse({ name: "Brand", sells: "soap", website: "javascript:alert(1)" }).success, false);
});
