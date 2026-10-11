import assert from "node:assert/strict";
import test from "node:test";
import { attentionItems, isThinBrand } from "./home-model.ts";

test("a brand is thin until every required brain field has content, whatever its ratio says", () => {
  assert.equal(isThinBrand({ requiredComplete: false }), true);
  assert.equal(isThinBrand({ requiredComplete: true }), false);
});

test("a thin brand is listed with the share of required fields filled, and a complete brand is not listed", () => {
  const items = attentionItems({
    reviewsByBrand: [],
    failedJobs: 0,
    connections: [],
    thinBrands: [{ brandId: "brand-a", brandName: "Soap Co", ratio: 0.5 }],
  });
  const thin = items.find((item) => item.id === "brain:brand-a");
  assert.equal(thin?.title, "Soap Co’s brand brain is thin");
  assert.equal(thin?.detail, "50% of required brain fields are filled");
  assert.equal(thin?.to, "/brands/$brandId/brain");
  const none = attentionItems({ reviewsByBrand: [], failedJobs: 0, connections: [], thinBrands: [] });
  assert.equal(none.some((item) => item.id.startsWith("brain:")), false);
});
