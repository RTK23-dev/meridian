import assert from "node:assert/strict";
import test from "node:test";
import type { BrainSlice, ObservedCreative, ProductFact } from "../domain.ts";
import { productNamedInCopy, runCoreLoop } from "./loop.ts";

const org = "org";
const brand = "brand";
const brain: BrainSlice = {
  positioning: "A plain soap. The proof is the lather, not a cure.",
  differentiators: "No clinic language.",
  problems: "",
  desires: "",
  objections: "",
  tone: "quiet",
  wordsToAvoid: "",
  preferredFormats: "short ugc",
  prohibitedClaims: "cures",
  requiredDisclaimers: "",
  targetCustomers: "people who already buy soap",
  valueProposition: "Lather you can see.",
};
const product: ProductFact = { id: "p", name: "North bar", description: "soap", allowedClaims: "lathers", prohibitedClaims: "cures" };

function creative(id: string, angle: string, hookType: string, text: string, origin: ObservedCreative["origin"]): ObservedCreative {
  return {
    id,
    organizationId: org,
    brandId: brand,
    origin,
    angle,
    hookType,
    format: "short_ugc",
    proofType: angle === "offer" ? "offer" : "demonstration",
    offer: "",
    cta: "",
    visualStyle: "plain",
    platform: "tiktok",
    emotion: "",
    productName: product.name,
    claim: "",
    text,
  };
}

const observations = [
  creative("c1", "offer", "offer", "discount save price", "competitor"),
  creative("c2", "offer", "offer", "discount save price again", "competitor"),
  creative("c3", "offer", "offer", "discount save price today only this exact line", "competitor"),
  creative("c4", "offer", "offer", "discount save price on the shelf", "competitor"),
  creative("c5", "lather-proof", "demonstration", "lather proof demonstration in one take", "competitor"),
];
const losers = [0, 1, 2].map((index) => creative(`lose-${index}`, "offer", "offer", "discount", "generated"));

function loopWith(copyPhrase?: string) {
  return runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations,
    losers,
    allowTestProviders: true,
    logoMatch: 0.92,
    paletteMatch: 0.7,
    copyPhrase,
  });
}

test("the copy names the product when the name appears in it, ignoring case and surrounding space", () => {
  assert.equal(productNamedInCopy("Try North Bar tonight", "North bar"), true);
  assert.equal(productNamedInCopy("  north bar  ", " North bar "), true);
  assert.equal(productNamedInCopy("Lather you can see", "North bar"), false);
  assert.equal(productNamedInCopy(undefined, "North bar"), false, "no copy names nothing");
  assert.equal(productNamedInCopy("Any copy at all", ""), false, "a blank product name names nothing");
  assert.equal(productNamedInCopy("Any copy at all", "   "), false, "a whitespace product name names nothing");
});

test("a product named only in the generation prompt is not named in the copy: product_match is refused", () => {
  const result = loopWith(undefined);
  // The precondition: the prompt really names the product. Otherwise this test would prove nothing.
  assert.ok(result.firstPrompt.toLowerCase().includes(product.name.toLowerCase()), "the generation prompt names the product");
  const audit = result.audits.find((item) => item.questionId === "product_match");
  assert.ok(audit, "the product question is audited");
  assert.equal(audit.decision, "REJECT", "a prompt that names the product does not satisfy the copy rule");
  assert.equal(result.externalId, null, "nothing is published");
});

test("a product named in the copy satisfies the product question", () => {
  const result = loopWith("North bar lathers in one take");
  const audit = result.audits.find((item) => item.questionId === "product_match");
  assert.ok(audit);
  assert.notEqual(audit.decision, "REJECT", "the copy names the product, so the local rule does not reject it");
});
