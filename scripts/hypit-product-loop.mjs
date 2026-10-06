/**
 * Live product-loop smoke.
 * Separate Hypit process, then the existing test publisher, synthetic performance, and existing learner.
 * Not part of the mocked unit suite. Does not call xAI or test:video.
 */
import { spawn } from "node:child_process";
import { liveTransport } from "../src/lib/meridian/providers/http.ts";
import { handoffToHypit, memoryHypitLedger } from "../src/lib/meridian/hypit/handoff.ts";
import { memoryPublishLedger, publishStoredHypitAsset } from "../src/lib/meridian/publishing/hypit-asset.ts";
import { planHypitTestPerformance } from "../src/lib/meridian/publishing/hypit-performance.ts";
import { learnPatterns } from "../src/lib/meridian/learning/engine.ts";
import { buildBrief } from "../src/lib/meridian/brief/engine.ts";
import { rankOpportunities } from "../src/lib/meridian/opportunity/engine.ts";

const port = process.env.HYPIT_BRIDGE_PORT || "8767";
const baseUrl = process.env.HYPIT_BASE_URL || `http://127.0.0.1:${port}`;
const hypitBin = process.env.HYPIT_BIN || "/opt/hypit-runtime/node_modules/.bin/hypit";

function waitForHealth(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hypit bridge did not start.")), 20000);
    const onData = (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Hypit bridge exited ${code} before listening.`));
    });
  });
}

const decision = {
  id: "dec-loop",
  organizationId: "org-live",
  brandId: "brand-live",
  questionId: "brief_gate",
  policyVersion: "code:brief_gate.v1",
  decision: "AUTO_APPROVE",
  reviewerDecision: "",
  reasons: ["Stored evidence supports this angle."],
  evidence: [{ id: "ev-loop", source: "market", summary: "The lather is visible." }],
};

const bridge = spawn(process.execPath, ["scripts/hypit-bridge.mjs"], {
  env: {
    ...process.env,
    HYPIT_BIN: hypitBin,
    HYPIT_FFPROBE: process.env.HYPIT_FFPROBE || "/tmp/ffprobe-pkg/node_modules/ffprobe-static/bin/linux/x64/ffprobe",
    HYPIT_FFMPEG: process.env.HYPIT_FFMPEG || "/usr/local/bin/ffmpeg",
    HYPIT_BRIDGE_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await waitForHealth(bridge);

try {
  const result = await handoffToHypit(
    {
      organizationId: "org-live",
      brandId: "brand-live",
      product: "North bar",
      objective: "Show the lather in the first second.",
      angle: "demonstration",
      visualDirection: "Close product. No extra promise.",
      tone: "quiet",
      cta: "See the bar",
      format: "short_ugc",
      aspectRatio: "9:16",
      durationSeconds: 2,
      requiredClaims: ["lathers"],
      prohibitedClaims: ["cures"],
      brandAssets: [],
      briefId: "brief-loop",
      decision,
    },
    { env: { baseUrl }, transport: liveTransport(), ledger: memoryHypitLedger() },
  );
  if (!result.ok || !result.artifactBytes || !result.job.artifact) {
    throw new Error(`${result.job.code}. ${result.job.error || "Hypit did not return a video."}`);
  }
  const published = await publishStoredHypitAsset(
    {
      organizationId: "org-live",
      brandId: "brand-live",
      jevDecisionId: decision.id,
      briefId: "brief-loop",
      hypitJobId: result.job.providerJobId,
      hypitStatus: "succeeded",
      decision: "AUTO_APPROVE",
      reviewerDecision: "",
      decisionOrganizationId: "org-live",
      decisionBrandId: "brand-live",
      storageKey: result.job.artifact.storageKey,
      sha256: result.job.artifact.sha256,
      mime: result.job.artifact.mime,
      byteLength: result.artifactBytes.byteLength,
      bytes: result.artifactBytes,
    },
    memoryPublishLedger(),
  );
  if (!published.published) throw new Error(published.reason);
  const performance = planHypitTestPerformance({
    receipt: {
      status: published.receipt.status,
      provider: "test",
      organizationId: "org-live",
      brandId: "brand-live",
      externalId: published.receipt.externalId,
      hypitJobId: result.job.providerJobId,
      sha256: result.job.artifact.sha256,
      jevDecisionId: decision.id,
      briefId: "brief-loop",
      storageKey: result.job.artifact.storageKey,
    },
    creative: {
      id: "creative-hypit-loop",
      organizationId: "org-live",
      brandId: "brand-live",
      origin: "generated",
      angle: "demonstration",
      hookType: "problem",
      format: "short_ugc",
      proofType: "demonstration",
      offer: "",
      cta: "See the bar",
      visualStyle: "",
      platform: "paid_social",
      emotion: "",
      productName: "North bar",
      claim: "",
      text: "demonstration creative-hypit-loop",
    },
    observedOn: "2026-01-02",
    impressions: 1000,
    clicks: 80,
    conversions: 8,
    spendCents: 1000,
    revenueCents: 4000,
    existing: [],
  });
  if (!performance.stored || performance.duplicate) throw new Error("Test performance was not stored.");
  const sibling = (id, angle, clicks) => ({
    creative: {
      id,
      organizationId: "org-live",
      brandId: "brand-live",
      origin: "generated",
      angle,
      hookType: angle === "offer" ? "offer" : "problem",
      format: "short_ugc",
      proofType: angle,
      offer: "",
      cta: "See the bar",
      visualStyle: "",
      platform: "paid_social",
      emotion: "",
      productName: "North bar",
      claim: "",
      text: `${angle} ${id}`,
    },
    observation: {
      creativeId: id,
      organizationId: "org-live",
      brandId: "brand-live",
      impressions: 1000,
      clicks,
      conversions: Math.round(clicks / 10),
      spendCents: 1000,
      revenueCents: clicks * 50,
    },
  });
  const prior = [
    sibling("c-demonstration-0", "demonstration", 80),
    sibling("c-demonstration-1", "demonstration", 80),
    sibling("c-offer-0", "offer", 20),
    sibling("c-offer-1", "offer", 20),
    sibling("c-offer-2", "offer", 20),
    sibling("c-offer-3", "offer", 20),
  ];
  const hypitCreative = {
    id: "creative-hypit-loop",
    organizationId: "org-live",
    brandId: "brand-live",
    origin: "generated",
    angle: "demonstration",
    hookType: "problem",
    format: "short_ugc",
    proofType: "demonstration",
    offer: "",
    cta: "See the bar",
    visualStyle: "",
    platform: "paid_social",
    emotion: "",
    productName: "North bar",
    claim: "",
    text: "demonstration creative-hypit-loop",
  };
  const creatives = [...prior.map((item) => item.creative), hypitCreative];
  const observations = [
    ...prior.map((item) => item.observation),
    {
      creativeId: "creative-hypit-loop",
      organizationId: "org-live",
      brandId: "brand-live",
      impressions: 1000,
      clicks: 80,
      conversions: 8,
      spendCents: 1000,
      revenueCents: 4000,
    },
  ];
  const patterns = learnPatterns({ organizationId: "org-live", brandId: "brand-live", creatives, observations });
  const brain = {
    positioning: "North bar shows a short wash.",
    differentiators: "",
    problems: "",
    desires: "",
    objections: "",
    tone: "quiet",
    wordsToAvoid: "",
    preferredFormats: "short ugc",
    prohibitedClaims: "",
    requiredDisclaimers: "",
    targetCustomers: "people who already buy the category",
    valueProposition: "A bar you can see working.",
  };
  const ranked = rankOpportunities({
    organizationId: "org-live",
    brandId: "brand-live",
    brain,
    products: [{ id: "prod", name: "North bar", description: "", allowedClaims: "lathers", prohibitedClaims: "cures" }],
    creatives,
    patterns,
    rejections: [],
  });
  const demo = ranked.find((item) => item.hypothesisId === "demonstration");
  if (!demo || demo.historicalEvidence <= 0) throw new Error("Learning did not change the demonstration recommendation.");
  const brief = buildBrief({ opportunity: demo, brain, patterns, rejections: [] });
  if (!brief.learningNotes.some((note) => note.includes("angle=demonstration"))) {
    throw new Error("The next brief did not include the learned demonstration pattern.");
  }
  console.log(JSON.stringify({
    ok: true,
    hypitJobId: result.job.providerJobId,
    sha256: result.job.artifact.sha256,
    byteLength: result.artifactBytes.byteLength,
    publishingExternalId: published.receipt.externalId,
    performanceExternalId: performance.record.externalId,
    performanceSource: performance.record.source,
    historicalEvidence: demo.historicalEvidence,
    learningNote: brief.learningNotes.find((note) => note.includes("angle=demonstration")),
  }, null, 2));
} finally {
  bridge.kill("SIGTERM");
}
