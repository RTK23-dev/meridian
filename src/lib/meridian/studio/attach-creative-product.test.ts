import assert from "node:assert/strict";
import test from "node:test";
import type { ProductFact } from "../domain.ts";
import { enableAppAliases } from "../../../test-support/lib/meridian/testing/module-aliases.ts";

// The server module uses the "@/" alias, so the alias hook is registered before the module is loaded.
enableAppAliases();
const { attachStatesFor, productForCreative } = await import("./creative-image.server.ts");

const alpha: ProductFact = { id: "a", name: "Alpha soap", description: "", allowedClaims: "", prohibitedClaims: "guaranteed results" };
const beta: ProductFact = { id: "b", name: "Beta sponge", description: "", allowedClaims: "", prohibitedClaims: "miracle cure" };
const products = [alpha, beta];

test("a stored product name decides the product, whatever the copy names", () => {
  const match = productForCreative(products, { product_name: "Beta sponge", raw_text: "Alpha soap lathers well.", title: "Alpha soap" });
  assert.equal(match.product, beta, "the stored product is used, not the one the copy names");
  assert.equal(match.evidence, "stored");
});

test("a stored product name is matched on its trimmed text", () => {
  const match = productForCreative(products, { product_name: "  Beta sponge ", raw_text: "", title: "" });
  assert.equal(match.product, beta);
});

test("a stored product name that resolves to nothing uses no product, and never the first product", () => {
  const match = productForCreative(products, { product_name: "Gamma gadget", raw_text: "Guaranteed results.", title: "" });
  assert.equal(match.product, null, "no other product stands in for an unresolved one");
  assert.equal(match.evidence, "unknown", "the product-specific claims are unknown");
});

test("with no stored name, the copy or title must name exactly one product", () => {
  assert.deepEqual(productForCreative(products, { product_name: "", raw_text: "Beta sponge, cleaner.", title: "" }), { product: beta, evidence: "copy" });
  assert.deepEqual(productForCreative(products, { product_name: "", raw_text: "", title: "Alpha soap launch" }), { product: alpha, evidence: "copy" });
});

test("with no stored name and two products named, the product is unknown rather than the first one", () => {
  const match = productForCreative(products, { product_name: "", raw_text: "Alpha soap and Beta sponge together.", title: "" });
  assert.equal(match.product, null);
  assert.equal(match.evidence, "unknown");
});

test("with no stored name and no product named, no product is claimed", () => {
  const match = productForCreative(products, { product_name: "", raw_text: "Mesh sponges that do not smell.", title: "Kitchen sponge" });
  assert.equal(match.product, null);
  assert.equal(match.evidence, "none", "a product the creative does not mention is not claimed");
});

test("a brand with no products claims none, and a stored name is still unknown", () => {
  assert.deepEqual(productForCreative([], { product_name: "", raw_text: "Anything.", title: "" }), { product: null, evidence: "none" });
  assert.equal(productForCreative([], { product_name: "Beta sponge", raw_text: "", title: "" }).evidence, "unknown");
});

test("blank product names never match", () => {
  const blank: ProductFact = { id: "c", name: "   ", description: "", allowedClaims: "", prohibitedClaims: "" };
  assert.deepEqual(productForCreative([blank], { product_name: "", raw_text: "Any copy at all.", title: "Any title" }), { product: null, evidence: "none" });
});

test("each judgment implies one creative status and one asset lifecycle", () => {
  assert.deepEqual(attachStatesFor("AUTO_APPROVE"), { creativeStatus: "approved", assetLifecycle: "approved" });
  assert.deepEqual(attachStatesFor("HUMAN_REVIEW"), { creativeStatus: "in_review", assetLifecycle: "qa_required" });
  assert.deepEqual(attachStatesFor("REJECT"), { creativeStatus: "rejected", assetLifecycle: "rejected" });
});
