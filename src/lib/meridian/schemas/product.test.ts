import assert from "node:assert/strict";
import test from "node:test";
import { productFieldsSchema } from "./product.ts";

test("product fields trim values and normalize a bare product URL", () => {
  const parsed = productFieldsSchema.parse({ name: "  Soap bar  ", description: "  Gentle soap  ", url: "example.test/item" });
  assert.equal(parsed.name, "Soap bar");
  assert.equal(parsed.description, "Gentle soap");
  assert.equal(parsed.url, "https://example.test/item");
  assert.equal(parsed.features, "");
  assert.equal(productFieldsSchema.parse({ name: "Bottle" }).url, "");
});

test("product fields reject missing names, overlong fields, and non-http URLs", () => {
  assert.equal(productFieldsSchema.safeParse({ name: "  " }).success, false);
  assert.equal(productFieldsSchema.safeParse({ name: "x".repeat(161) }).success, false);
  assert.equal(productFieldsSchema.safeParse({ name: "Soap", url: "javascript:alert(1)" }).success, false);
});
