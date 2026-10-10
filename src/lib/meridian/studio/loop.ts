import { walkToQa, advanceAsset, type AssetLineage, type AssetState } from "../assets/pipeline.ts";
import { assertSameTenant, type BrainSlice, type LearnedPattern, type ObservedCreative, type PerformanceRow, type ProductFact, type RejectionFact } from "../domain.ts";
import { fingerprintCreative, type CreativeFingerprint } from "../intelligence/fingerprint.ts";
import { clusterFingerprints, findWhitespace, testLoopEmbedding, type MarketCluster, type WhitespaceFinding } from "../intelligence/whitespace.ts";
import { QUESTION_SPECS, fitReviewerCalibration, judgeFeatures, PRIOR_JUDGMENT, REVIEW_POLICY, type AuditedDecision, type Feature, type JudgmentModel } from "../jev/judgment.ts";
import { learnPatterns } from "../learning/engine.ts";
import { rankFromEvidence, type PosteriorRank } from "../opportunity/posterior.ts";
import { advanceTestVideo, runUntilSettled, startTestVideo, testImageProvider, type ImageResult, type VideoJob } from "../providers/media.ts";
import { buildBrief, type BriefDraft } from "../brief/engine.ts";

export type LoopAsset = {
  id: string;
  kind: "image" | "video";
  state: AssetState;
  lineage: AssetLineage;
  image?: Extract<ImageResult, { status: "ready" }>;
  video?: VideoJob;
};

export type CoreLoopResult = {
  fingerprints: CreativeFingerprint[];
  clusters: MarketCluster[];
  whitespace: WhitespaceFinding[];
  firstRank: PosteriorRank[];
  chosen: PosteriorRank;
  audits: AuditedDecision[];
  brief: BriefDraft;
  assets: LoopAsset[];
  reviewDecision: "approve" | "reject" | "review";
  externalId: string | null;
  reused: boolean;
  patterns: LearnedPattern[];
  secondRank: PosteriorRank[];
  secondBrief: BriefDraft;
  firstPrompt: string;
  secondPrompt: string;
};

type Publisher = {
  publish: (key: string, stage: string, fail?: boolean) => { externalId: string | null; reused: boolean; error: string };
};

function publisher(allow: boolean): Publisher {
  if (!allow) throw new Error("The test publisher is not enabled.");
  const stored = new Map<string, string>();
  return {
    publish(key, stage, fail = false) {
      const idKey = `${key}:${stage}`;
      const prior = stored.get(idKey);
      if (prior) return { externalId: prior, reused: true, error: "" };
      if (fail) return { externalId: null, reused: false, error: `test:${stage} failed before an id existed.` };
      const externalId = `test:${idKey}`;
      stored.set(idKey, externalId);
      return { externalId, reused: false, error: "" };
    },
  };
}

function feature(name: string, value: number, summary: string): Feature {
  return { name, value, evidenceId: name, source: "structured", summary };
}

function promptFrom(brief: BriefDraft): string {
  return [brief.hook, brief.message, brief.constraints, ...brief.learningNotes].filter(Boolean).join("\n");
}

export function runCoreLoop(input: {
  organizationId: string;
  brandId: string;
  brain: BrainSlice;
  product: ProductFact;
  observations: ObservedCreative[];
  losers: ObservedCreative[];
  allowTestProviders: boolean;
  logoMatch: number | null;
  paletteMatch: number | null;
  copyPhrase?: string;
  omitVideoEvidence?: boolean;
}): CoreLoopResult {
  if (!input.allowTestProviders) throw new Error("Test providers are off. Nothing was generated.");
  assertSameTenant(input.observations, input.organizationId, input.brandId);
  assertSameTenant(input.losers, input.organizationId, input.brandId);
  const fingerprints = input.observations.map((creative) => fingerprintCreative(creative, input.brain));
  const embedded = input.observations.map((creative) => ({
    id: creative.id,
    origin: creative.origin,
    angle: creative.angle,
    vector: testLoopEmbedding(`${creative.angle} ${creative.text}`),
  }));
  const clusters = clusterFingerprints(embedded);
  const whitespace = findWhitespace({
    fingerprints,
    origins: input.observations.map((creative) => ({ id: creative.id, origin: creative.origin })),
    brandText: `${input.brain.positioning} ${input.brain.valueProposition}`,
  });
  const discovered = whitespace.map((finding) => ({
    id: finding.id,
    source: "discovered" as const,
    label: `Whitespace: ${finding.underused.replaceAll("-", " ")}`,
    angle: finding.underused,
    hookType: "demonstration",
    format: "short_ugc",
    proofType: "demonstration",
    reason: finding.whyTest,
    evidenceIds: finding.evidenceIds,
    alignment: finding.alignsWithBrand ? 0.9 : 0.2,
  }));
  const firstRank = rankFromEvidence({
    discovered,
    patterns: [],
    performance: [],
    seed: input.brandId,
  });
  const chosen = firstRank.find((item) => item.source === "discovered") ?? firstRank[0];
  if (!chosen) throw new Error("No candidate was produced.");
  const brief = buildBrief({
    opportunity: {
      hypothesisId: chosen.id,
      source: "discovered",
      label: chosen.label,
      category: "whitespace",
      angle: chosen.angle,
      hookType: chosen.hookType,
      audience: input.brain.targetCustomers,
      format: chosen.format,
      proofType: chosen.proofType,
      productId: input.product.id,
      productName: input.product.name,
      marketSignal: 0,
      novelty: 0,
      brandFit: chosen.alignment,
      reproducibility: 0,
      risk: 0,
      saturation: 0,
      historicalEvidence: 0,
      expectedValue: chosen.score,
      rawScore: chosen.score,
      reason: chosen.reason,
      evidence: chosen.evidenceIds.map((id) => ({ id, source: "observation", summary: chosen.reason })),
      evidenceBasis: "market",
      supportingCreativeIds: chosen.evidenceIds,
      confidence: 0.6,
      hookDirection: `Show ${input.product.name} doing the job. Do not copy a competitor line.`,
    },
    brain: input.brain,
    patterns: [],
    rejections: [],
  });
  const firstPrompt = promptFrom(brief);
  const images = testImageProvider(true);
  const assets: LoopAsset[] = [];
  for (const variant of ["a", "b", "c"]) {
    const settled = runUntilSettled(() => {
      const image = images.generate({ prompt: firstPrompt, seed: `${chosen.angle}-${variant}`, promptVersion: "brief-v1" });
      return image.status === "ready" ? { ok: true, value: image } : { ok: false, error: image.error };
    });
    if (settled.status !== "ready") throw new Error(settled.error);
    const video = input.omitVideoEvidence
      ? startTestVideo({ prompt: firstPrompt, seed: `${chosen.angle}-${variant}`, promptVersion: "brief-v1" }, true)
      : [0, 1, 2].reduce((job) => advanceTestVideo(job, true), startTestVideo({ prompt: firstPrompt, seed: `${chosen.angle}-${variant}`, promptVersion: "brief-v1" }, true));
    const states = walkToQa();
    assets.push({
      id: `image-${variant}`,
      kind: "image",
      state: states[states.length - 1] ?? "qa_required",
      image: settled.value,
      lineage: lineage(input.brandId, chosen.id, brief.title, variant, settled.value.provider, settled.value.model),
    });
    assets.push({
      id: `video-${variant}`,
      kind: "video",
      state: "qa_required",
      video,
      lineage: lineage(input.brandId, chosen.id, brief.title, variant, video.provider, video.model),
    });
  }
  const copy = `${firstPrompt} ${input.copyPhrase ?? ""}`;
  const competitorText = input.observations.filter((item) => item.origin === "competitor").map((item) => item.text).join(" ");
  const copies = Boolean(input.copyPhrase && input.copyPhrase.length > 12 && competitorText.includes(input.copyPhrase));
  const audits = QUESTION_SPECS.map((spec) => {
    const features = featuresFor(spec.id, {
      aligned: input.logoMatch != null && input.logoMatch >= 0.8,
      logoMismatch: input.logoMatch != null && input.logoMatch < 0.4,
      paletteMissing: input.paletteMatch == null,
      productNamed: copy.toLowerCase().includes(input.product.name.toLowerCase()) || brief.message.toLowerCase().includes(input.product.name.toLowerCase()),
      copies,
      imageReady: assets.some((asset) => asset.kind === "image" && asset.image),
      videoReady: !input.omitVideoEvidence && assets.some((asset) => asset.video?.status === "completed" && (Boolean(asset.video.transcript) || asset.video.scenes.length > 0)),
      saturated: false,
      logoKnown: input.logoMatch != null,
    });
    const present = spec.id === "logo_match" ? input.logoMatch != null : spec.id === "palette_match" ? input.paletteMatch != null : spec.id === "video_readiness" ? features.some((item) => item.name === "aligned" && item.value === 1) : features.length > 0;
    return judgeFeatures(spec, features, PRIOR_JUDGMENT, present);
  });
  const blocked = audits.some((audit) => ["claim_safety", "brand_safety", "competitor_copy_risk", "logo_match", "product_match", "publishing_readiness"].includes(audit.questionId) && audit.decision === "REJECT");
  const needsPerson = !blocked && audits.some((audit) => audit.decision === "HUMAN_REVIEW");
  const reviewDecision = blocked ? "reject" : needsPerson ? "review" : "approve";
  const reviewerApproved = reviewDecision === "approve" || (reviewDecision === "review" && input.logoMatch != null && !input.omitVideoEvidence && !copies);
  let externalId: string | null = null;
  let reused = false;
  if (reviewerApproved) {
    const pub = publisher(true);
    const campaign = pub.publish(chosen.id, "campaign");
    const ad = pub.publish(chosen.id, "ad");
    externalId = ad.externalId;
    reused = campaign.reused || ad.reused;
    for (const asset of assets) {
      asset.state = advanceAsset(asset.state, "approved");
      if (externalId) asset.state = advanceAsset(asset.state, "published");
      asset.lineage = { ...asset.lineage, qaDecision: reviewDecision, reviewDecision: reviewerApproved ? "approve" : reviewDecision, publicationId: externalId ?? "" };
    }
  }
  const winnerRows = assets.filter((asset) => asset.kind === "image").map((asset, index) => performanceRow(input, `win-${index}`, 400, 40, 4));
  const loserRows = input.losers.map((creative) => ({ ...performanceRow(input, creative.id, 400, 8, 0), creativeId: creative.id }));
  const patterns = learnPatterns({
    organizationId: input.organizationId,
    brandId: input.brandId,
    creatives: [
      ...assets.filter((asset) => asset.kind === "image").map((asset, index) => generatedCreative(input, `win-${index}`, chosen.angle, "demonstration")),
      ...input.losers,
    ],
    observations: [...winnerRows, ...loserRows],
  });
  const secondRank = rankFromEvidence({
    discovered,
    patterns,
    performance: [
      ...winnerRows.map(() => ({ angle: chosen.angle, clicks: 40, impressions: 400 })),
      ...input.losers.map((creative) => ({ angle: creative.angle, clicks: 8, impressions: 400 })),
    ],
    seed: input.brandId,
  });
  const secondChoice = secondRank.find((item) => item.angle === chosen.angle) ?? secondRank[0] ?? chosen;
  const secondBrief = buildBrief({
    opportunity: {
      hypothesisId: secondChoice.id,
      source: "discovered",
      label: secondChoice.label,
      category: "whitespace",
      angle: secondChoice.angle,
      hookType: secondChoice.hookType,
      audience: input.brain.targetCustomers,
      format: secondChoice.format,
      proofType: secondChoice.proofType,
      productId: input.product.id,
      productName: input.product.name,
      marketSignal: 0,
      novelty: 0,
      brandFit: secondChoice.alignment,
      reproducibility: 0,
      risk: 0,
      saturation: 0,
      historicalEvidence: secondChoice.shrunkLift,
      expectedValue: secondChoice.score,
      rawScore: secondChoice.score,
      reason: secondChoice.reason,
      evidence: secondChoice.evidenceIds.map((id) => ({ id, source: "observation", summary: secondChoice.reason })),
      evidenceBasis: "mixed",
      supportingCreativeIds: secondChoice.evidenceIds,
      confidence: 0.7,
      hookDirection: brief.hook,
    },
    brain: input.brain,
    patterns,
    rejections: [{ reasonCode: "off_brand", count: 1 }],
  });
  const negativeLines = patterns.filter((pattern) => pattern.lift < 0).map((pattern) => `Do not prefer ${pattern.attribute}=${pattern.value}.`);
  secondBrief.constraints = [secondBrief.constraints, ...negativeLines].filter(Boolean).join("\n");
  return {
    fingerprints,
    clusters,
    whitespace,
    firstRank,
    chosen,
    audits,
    brief,
    assets,
    reviewDecision,
    externalId,
    reused,
    patterns,
    secondRank,
    secondBrief,
    firstPrompt,
    secondPrompt: promptFrom(secondBrief),
  };
}

export function emptyWhitespace(): WhitespaceFinding[] {
  return findWhitespace({ fingerprints: [], origins: [], brandText: "soap" });
}

export function retryPublish(allow: boolean): { first: string | null; secondReused: boolean; resumed: string | null } {
  const pub = publisher(allow);
  const first = pub.publish("creative", "campaign");
  const failed = pub.publish("creative", "ad", true);
  const againCampaign = pub.publish("creative", "campaign");
  const resumed = failed.externalId ? failed : pub.publish("creative", "ad");
  return { first: first.externalId, secondReused: againCampaign.reused, resumed: resumed.externalId };
}

export function deadImage(allow: boolean): { status: string; attempts: number } {
  const images = testImageProvider(allow, 3);
  const settled = runUntilSettled(() => {
    const image = images.generate({ prompt: "soap", seed: "dead", promptVersion: "v1" });
    return image.status === "ready" ? { ok: true, value: image } : { ok: false, error: image.error };
  });
  return { status: settled.status, attempts: settled.attempts };
}

export function calibrationChangesProbability(): { before: number; after: number; activated: boolean; thresholdsSame: boolean; smallSample: boolean } {
  const spec = QUESTION_SPECS.find((item) => item.id === "creative_quality");
  if (!spec) throw new Error("creative_quality is missing from the registry.");
  const features = [feature("aligned", 1, "The variant has a hook."), feature("coverage", 1, "The brief has the required fields.")];
  const before = judgeFeatures(spec, features, PRIOR_JUDGMENT, true);
  const rows = Array.from({ length: 40 }, () => ({ features: features.map((item) => ({ name: item.name, value: item.value })), approved: false }));
  const fitted = fitReviewerCalibration(PRIOR_JUDGMENT, rows, 30);
  const after = judgeFeatures(spec, features, fitted.model, true);
  const small = fitReviewerCalibration(PRIOR_JUDGMENT, rows.slice(0, 5), 30);
  return {
    before: before.probability,
    after: after.probability,
    activated: fitted.status === "fitted",
    thresholdsSame: JSON.stringify(before.policy) === JSON.stringify(REVIEW_POLICY) && JSON.stringify(after.policy) === JSON.stringify(before.policy),
    smallSample: small.status === "insufficient" && small.model.version === PRIOR_JUDGMENT.version,
  };
}

export function questionIds(): string[] {
  return QUESTION_SPECS.map((spec) => spec.id);
}

function featuresFor(
  id: string,
  flags: {
    aligned: boolean;
    logoMismatch: boolean;
    paletteMissing: boolean;
    productNamed: boolean;
    copies: boolean;
    imageReady: boolean;
    videoReady: boolean;
    saturated: boolean;
    logoKnown: boolean;
  },
): Feature[] {
  if (id === "logo_match") {
    // A measured mismatch is a violation, not a score, as features.ts classifies it. A score cannot reject without calibration.
    if (flags.logoMismatch) return [feature("violation", 1, "Logo similarity is below the match line.")];
    if (flags.aligned) return [feature("aligned", 1, "Logo similarity supports the stored mark.")];
    return [];
  }
  if (id === "palette_match") {
    if (flags.paletteMissing) return [];
    return [feature("aligned", 1, "Palette similarity was supplied.")];
  }
  if (id === "competitor_copy_risk") {
    return flags.copies
      ? [feature("violation", 1, "The copy repeats competitor wording.")]
      : [feature("aligned", 1, "The copy does not repeat a stored competitor line.")];
  }
  if (id === "product_match") {
    return flags.productNamed
      ? [feature("aligned", 1, "The briefed product is named.")]
      : [feature("mismatch", 1, "The briefed product is not in the copy.")];
  }
  if (id === "image_readiness") {
    return flags.imageReady ? [feature("aligned", 1, "An image object was stored.")] : [];
  }
  if (id === "video_readiness") {
    return flags.videoReady ? [feature("aligned", 1, "The video job completed with scene evidence.")] : [];
  }
  if (id === "market_saturation") {
    return flags.saturated ? [feature("violation", 1, "This direction is saturated in stored ads.")] : [feature("aligned", 1, "Stored ads do not saturate this direction.")];
  }
  if (id === "publishing_readiness") {
    return flags.imageReady && flags.videoReady && flags.logoKnown && !flags.copies && !flags.logoMismatch
      ? [feature("aligned", 1, "Image, video, and brand checks are present."), feature("coverage", 1, "The brief has the fields a publisher needs.")]
      : [feature("violation", 1, "Publishing evidence is incomplete or failed a brand check.")];
  }
  return [feature("aligned", 1, `${id} has supporting structured evidence.`), feature("coverage", 1, `${id} has the fields the schema requires.`)];
}

function lineage(brandId: string, opportunityId: string, briefTitle: string, variant: string, provider: string, model: string): AssetLineage {
  return {
    brandId,
    opportunityId,
    briefTitle,
    workflowId: "test-workflow",
    variant,
    provider,
    model,
    promptVersion: "brief-v1",
    generationRun: `${opportunityId}:${variant}`,
    assetVersion: 1,
    qaDecision: "",
    reviewDecision: "",
    publicationId: "",
    performanceId: "",
  };
}

function performanceRow(
  input: { organizationId: string; brandId: string },
  creativeId: string,
  impressions: number,
  clicks: number,
  conversions: number,
): PerformanceRow {
  return {
    creativeId,
    organizationId: input.organizationId,
    brandId: input.brandId,
    impressions,
    clicks,
    conversions,
    spendCents: 1000,
    revenueCents: conversions * 2000,
  };
}

function generatedCreative(
  input: { organizationId: string; brandId: string; product: ProductFact },
  id: string,
  angle: string,
  hookType: string,
): ObservedCreative {
  return {
    id,
    organizationId: input.organizationId,
    brandId: input.brandId,
    origin: "generated",
    angle,
    hookType,
    format: "short_ugc",
    proofType: "demonstration",
    offer: "",
    cta: "learn",
    visualStyle: "plain",
    platform: "tiktok",
    emotion: "",
    productName: input.product.name,
    claim: "",
    text: angle,
  };
}

export type { JudgmentModel, RejectionFact };
