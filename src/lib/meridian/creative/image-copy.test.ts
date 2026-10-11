import assert from "node:assert/strict";
import test from "node:test";
import { judgeMedia } from "../studio/features.ts";
import { CreativeDecisionEngine } from "./engine.ts";

// The brief's own words never name the product, so any product name in the copy must come from the engine.
const PRODUCT = "Mesh sponge";

function imageCopies(): string[] {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: { decisionId: "jev-copy-test", evidenceRefs: ["ev-copy-test"] },
    productionContext: { title: "Kitchen sponge", audience: "Adults with dry hands", angle: "live demonstration", productName: PRODUCT, opportunityId: null },
    scope: "image_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "google_nano_banana",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: PRODUCT,
      aspectRatio: "1:1",
      decisionId: "jev-copy-test",
    },
  });
  return plan.deliverables.filter((deliverable) => deliverable.kind === "image").map((deliverable) => deliverable.copy);
}

test("the copy the engine writes for each image names the product, and the product rule accepts that copy alone", () => {
  const copies = imageCopies();
  assert.ok(copies.length > 0, "the plan has image deliverables");
  for (const copy of copies) {
    assert.ok(copy.toLowerCase().includes(PRODUCT.toLowerCase()), `the image copy names “${PRODUCT}”: ${JSON.stringify(copy)}`);
    // The prompt and the stored metadata are empty here, so only the copy can satisfy the check.
    const decisions = judgeMedia({
      kind: "image",
      positioning: "The point is the mesh layer and the proof of a simple sponge.",
      tone: "plain",
      prohibited: "",
      wordsToAvoid: "",
      productName: PRODUCT,
      angle: "live_demonstration",
      copy,
      prompt: "",
      competitorTexts: [],
      ownTexts: [],
      mime: "image/png",
      byteSize: 70,
      width: 64,
      height: 64,
      checksum: "abc123def4567890",
      durationMs: null,
      transcript: "",
      sceneCount: 0,
      logoSimilarity: null,
      paletteDistance: null,
      semanticSimilarity: null,
    });
    const product = decisions.find((item) => item.questionId === "product_match");
    assert.notEqual(product?.decision, "REJECT", "the copy alone satisfies the product check");
    assert.doesNotMatch(product?.reasons[0] ?? "", /not in the copy/);
  }
});
