import assert from "node:assert/strict";
import test from "node:test";
import type { BrainSlice, ObservedCreative, ProductFact } from "../domain.ts";
import { learnPatterns } from "../learning/engine.ts";
import { readMp4Timing } from "../video/provider.ts";
import { calibrationChangesProbability, deadImage, emptyWhitespace, questionIds, retryPublish, runCoreLoop } from "./loop.ts";

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

test("one brand moves from observations through media, review, publish, and a different next brief", () => {
  const observations = [
    creative("c1", "offer", "offer", "discount save price", "competitor"),
    creative("c2", "offer", "offer", "discount save price again", "competitor"),
    creative("c3", "offer", "offer", "discount save price today only this exact line", "competitor"),
    creative("c4", "lather-proof", "demonstration", "lather proof demonstration of the bar", "competitor"),
    creative("c5", "lather-proof", "demonstration", "lather proof demonstration in one take", "competitor"),
  ];
  const losers = [0, 1, 2].map((index) => creative(`lose-${index}`, "offer", "offer", "discount", "generated"));
  const result = runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations,
    losers,
    allowTestProviders: true,
    logoMatch: 0.92,
    paletteMatch: 0.7,
  });

  assert.equal(emptyWhitespace().length, 0);
  assert.ok(result.whitespace.some((item) => item.underused === "lather-proof" && item.overused === "offer" && item.evidenceIds.includes("c4")));
  assert.equal(result.chosen.source, "discovered");
  assert.equal(result.chosen.angle, "lather-proof");
  assert.equal(result.chosen.id.startsWith("exploration:"), false);
  assert.ok(result.firstRank.some((item) => item.source === "exploration"));
  assert.equal(result.fingerprints.length, observations.length);
  assert.ok(result.clusters.length >= 2);
  assert.deepEqual(result.audits.map((item) => item.questionId), questionIds());
  assert.equal(questionIds().length, 20);
  assert.ok(result.audits.every((item) => item.modelVersion === "v1" && item.policy.autoApprove === 0.82));
  const images = result.assets.filter((asset) => asset.kind === "image");
  const videos = result.assets.filter((asset) => asset.kind === "video");
  assert.equal(images.length, 3);
  assert.equal(videos.length, 3);
  assert.ok(images.every((asset) => asset.image?.provider === "test:image" && asset.image.objectKey.endsWith(".png") && asset.state === "published"));
  assert.ok(videos.every((asset) => asset.video?.provider === "test:video" && asset.video.status === "completed"));
  const timing = readMp4Timing(videos[0]?.video?.bytes ?? new Uint8Array());
  assert.equal(timing?.durationMs, 2500);
  assert.equal(images[0]?.lineage.brandId, brand);
  assert.equal(images[0]?.lineage.opportunityId, result.chosen.id);
  assert.ok(result.externalId?.startsWith("test:"));
  assert.ok(result.patterns.some((pattern) => pattern.value === "lather-proof" && pattern.lift > 0));
  assert.ok(result.patterns.some((pattern) => pattern.value.startsWith("offer") && pattern.lift < 0));
  assert.ok(result.patterns.some((pattern) => pattern.attribute.includes("+")));
  const before = result.firstRank.find((item) => item.angle === "lather-proof")?.score ?? 0;
  const after = result.secondRank.find((item) => item.angle === "lather-proof")?.score ?? 0;
  const offerBefore = result.firstRank.find((item) => item.angle === "offer")?.score ?? 0;
  const offerAfter = result.secondRank.find((item) => item.angle === "offer")?.score ?? 0;
  assert.ok(after > before);
  assert.ok(offerAfter < offerBefore);
  assert.notEqual(result.secondPrompt, result.firstPrompt);
  assert.match(result.secondPrompt, /Do not prefer/);
  assert.match(result.secondBrief.constraints, /off_brand/);
  assert.ok(result.secondBrief.learningNotes.length > 0);

  const thin = learnPatterns({
    organizationId: org,
    brandId: brand,
    creatives: losers.slice(0, 2),
    observations: losers.slice(0, 2).map((item) => ({
      creativeId: item.id,
      organizationId: org,
      brandId: brand,
      impressions: 400,
      clicks: 10,
      conversions: 1,
      spendCents: 1000,
      revenueCents: null,
    })),
  });
  assert.equal(thin.length, 0);
  assert.throws(() => runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations: [{ ...observations[0]!, brandId: "other" }],
    losers: [],
    allowTestProviders: true,
    logoMatch: 0.9,
    paletteMatch: 0.7,
  }), /Tenant scope/);

  const logo = runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations,
    losers,
    allowTestProviders: true,
    logoMatch: 0.1,
    paletteMatch: 0.7,
  });
  assert.equal(logo.audits.find((item) => item.questionId === "logo_match")?.decision, "REJECT");
  assert.equal(logo.externalId, null);

  const missingVideo = runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations,
    losers,
    allowTestProviders: true,
    logoMatch: 0.92,
    paletteMatch: 0.7,
    omitVideoEvidence: true,
  });
  assert.equal(missingVideo.audits.find((item) => item.questionId === "video_readiness")?.decision, "HUMAN_REVIEW");
  assert.equal(missingVideo.externalId, null);

  const copied = runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations,
    losers,
    allowTestProviders: true,
    logoMatch: 0.92,
    paletteMatch: 0.7,
    copyPhrase: "today only this exact line",
  });
  assert.equal(copied.audits.find((item) => item.questionId === "competitor_copy_risk")?.decision, "REJECT");
  assert.equal(copied.externalId, null);

  const resumed = retryPublish(true);
  assert.ok(resumed.first?.startsWith("test:"));
  assert.equal(resumed.secondReused, true);
  assert.ok(resumed.resumed?.endsWith(":ad"));
  const dead = deadImage(true);
  assert.equal(dead.status, "dead");
  assert.equal(dead.attempts, 3);
  const fitted = calibrationChangesProbability();
  assert.equal(fitted.activated, true);
  assert.ok(fitted.after < fitted.before);
  assert.equal(fitted.thresholdsSame, true);
  assert.equal(fitted.smallSample, true);
  assert.throws(() => runCoreLoop({
    organizationId: org,
    brandId: brand,
    brain,
    product,
    observations,
    losers,
    allowTestProviders: false,
    logoMatch: null,
    paletteMatch: null,
  }), /Test providers are off/);
});
