import assert from "node:assert/strict";
import test from "node:test";
import { judgeMedia, rollupDecision, sharedPhrase } from "./features.ts";

const base = {
  kind: "image" as const,
  positioning: "The point is the lather and the proof of a simple bar.",
  tone: "plain",
  prohibited: "",
  wordsToAvoid: "",
  productName: "Lather bar",
  angle: "lather_proof",
  copy: "Lather bar, shown in one take. No borrowed line.",
  prompt: "Still of Lather bar. Angle lather_proof.",
  competitorTexts: ["today only this exact line from a rival"],
  ownTexts: [],
  mime: "image/svg+xml",
  byteSize: 80,
  width: 64,
  height: 64,
  checksum: "abc123def4567890",
  durationMs: null,
  transcript: "",
  sceneCount: 0,
  logoSimilarity: null,
  paletteDistance: null,
  semanticSimilarity: null,
};

test("missing logo evidence stays in human review", () => {
  const decisions = judgeMedia(base);
  const logo = decisions.find((item) => item.questionId === "logo_match");
  assert.equal(logo?.decision, "HUMAN_REVIEW");
  assert.equal(rollupDecision(decisions), "HUMAN_REVIEW");
});

test("a stored competitor phrase rejects the variant", () => {
  const decisions = judgeMedia({
    ...base,
    copy: "today only this exact line from a rival",
    logoSimilarity: 0.9,
    paletteDistance: 0.1,
  });
  const copy = decisions.find((item) => item.questionId === "competitor_copy_risk");
  assert.equal(copy?.decision, "REJECT");
  assert.equal(rollupDecision(decisions), "REJECT");
  assert.ok(sharedPhrase(base.copy, base.competitorTexts) === "");
});

test("video without scenes is not approved", () => {
  const decisions = judgeMedia({
    ...base,
    kind: "video",
    byteSize: 32,
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    mime: "video/mp4",
  });
  assert.equal(decisions.find((item) => item.questionId === "video_readiness")?.decision, "HUMAN_REVIEW");
});

test("a product name present only in the generation prompt does not satisfy the product check", () => {
  const decisions = judgeMedia({
    ...base,
    productName: "Mesh sponge",
    copy: "Swipe to see the antibacterial layer.",
    prompt: "Still of Mesh sponge on a kitchen sink.",
  });
  const product = decisions.find((item) => item.questionId === "product_match");
  assert.equal(product?.decision, "REJECT", "the copy does not name the product, so the prompt cannot satisfy the check");
  assert.match(product?.reasons[0] ?? "", /not in the copy/);
  assert.equal(rollupDecision(decisions), "REJECT");
});

test("the product check is satisfied by the copy, and the prompt is not needed", () => {
  const decisions = judgeMedia({ ...base, productName: "Lather bar", copy: "Lather bar, shown in one take.", prompt: "" });
  assert.notEqual(decisions.find((item) => item.questionId === "product_match")?.decision, "REJECT");
});

test("a prohibited claim present only in the copy is caught", () => {
  const decisions = judgeMedia({
    ...base,
    prohibited: "guaranteed results",
    copy: "Guaranteed results in one wash.",
    prompt: "Still of Lather bar, clean and bright.",
    logoSimilarity: 0.9,
    paletteDistance: 0.1,
  });
  assert.equal(decisions.find((item) => item.questionId === "claim_safety")?.decision, "REJECT");
  assert.equal(rollupDecision(decisions), "REJECT");
});

test("the generation prompt is not read as copy: a prohibited claim only in the prompt is not a copy violation", () => {
  const decisions = judgeMedia({
    ...base,
    prohibited: "guaranteed results",
    copy: "Lather bar, shown in one take.",
    prompt: "Still of Lather bar. Guaranteed results in the caption.",
    logoSimilarity: 0.9,
    paletteDistance: 0.1,
  });
  assert.notEqual(decisions.find((item) => item.questionId === "claim_safety")?.decision, "REJECT");
});
