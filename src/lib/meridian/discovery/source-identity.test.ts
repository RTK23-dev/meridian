import assert from "node:assert/strict";
import test from "node:test";
import { sourceExternalId } from "./source-identity.ts";

test("items with the same web canonical URL share one source key within a brand", () => {
  assert.equal(
    sourceExternalId({ brandId: "brand-a", itemId: "item_run1_1", canonicalUrl: "https://shop.example/p?id=1&utm_source=x" }),
    sourceExternalId({ brandId: "brand-a", itemId: "item_run2_9", canonicalUrl: "https://shop.example/p?id=1" }),
  );
});

test("the same web URL in two brands gets two keys, so one brand cannot overwrite the other's source", () => {
  assert.notEqual(
    sourceExternalId({ brandId: "brand-a", itemId: "item_run1_1", canonicalUrl: "https://shop.example/p" }),
    sourceExternalId({ brandId: "brand-b", itemId: "item_run1_1", canonicalUrl: "https://shop.example/p" }),
  );
});

test("items without a web URL keep their run-scoped identity, so shared free-text seeds never merge unrelated results", () => {
  const seed = "kitchen sponge";
  assert.notEqual(
    sourceExternalId({ brandId: "brand-a", itemId: "item_run1_1", canonicalUrl: seed }),
    sourceExternalId({ brandId: "brand-a", itemId: "item_run1_2", canonicalUrl: seed }),
  );
});

test("a malformed URL-looking string is not treated as a web URL", () => {
  assert.notEqual(
    sourceExternalId({ brandId: "brand-a", itemId: "item_run1_1", canonicalUrl: "https://exa mple" }),
    sourceExternalId({ brandId: "brand-a", itemId: "item_run1_2", canonicalUrl: "https://exa mple" }),
  );
});
