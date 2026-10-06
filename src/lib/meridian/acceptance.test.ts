import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ingestComposedText } from "./assets/lifecycle.ts";
import { calibrationReport } from "./calibration/report.ts";
import type { BrainSlice, LearnedPattern, ObservedCreative, PerformanceRow } from "./domain.ts";
import { designExperiment } from "./experiments/design.ts";
import { buildBrief } from "./brief/engine.ts";
import { decide } from "./jev/engine.ts";
import { questionRegistry } from "./jev/registry.ts";
import { opportunityGate, visualQa } from "./jev/questions.ts";
import { createJobQueue, learningJobKey } from "./jobs/runner.ts";
import { learnPatterns } from "./learning/engine.ts";
import { explainOpportunity, rankOpportunities } from "./opportunity/engine.ts";
import { assessCopy } from "./production/assess.ts";
import { routeApproval } from "./production/route.ts";
import { INTEGRATIONS } from "./providers/integrations.ts";
import { classifyAgainst, clusterBy, NEURAL_EMBEDDING, whitespaceAngles } from "./semantic/lexical.ts";

const org = "org-acceptance";
const brand = "brand-acceptance";

function brain(): BrainSlice {
  return {
    positioning: "A direct offer for people comparing price. Save. Deal. Offer.",
    differentiators: "",
    problems: "dry hands",
    desires: "",
    objections: "",
    tone: "plain",
    wordsToAvoid: "",
    preferredFormats: "short ugc",
    prohibitedClaims: "cures eczema",
    requiredDisclaimers: "",
    targetCustomers: "people who already buy the category",
    valueProposition: "North Soap washes hands.",
  };
}

function own(index: number, angle: string): ObservedCreative {
  return {
    id: `own-${angle}-${index}`,
    organizationId: org,
    brandId: brand,
    origin: "own",
    angle,
    hookType: angle,
    format: angle === "offer" ? "static" : "short_ugc",
    proofType: angle,
    offer: "",
    cta: "Shop",
    visualStyle: "",
    platform: "paid_social",
    emotion: "",
    productName: "North Soap",
    claim: "washes hands",
    text: `${angle} creative ${index}. North Soap washes hands.`,
  };
}

test("acceptance: market evidence becomes a recommendation, then learning changes the next one", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../evals/acceptance/market.json", import.meta.url), "utf8")) as {
    competitors: { id: string; angle: string; hookType: string; format: string; proofType: string; text: string }[];
  };
  const competitors: ObservedCreative[] = fixture.competitors.map((row) => ({
    id: row.id,
    organizationId: org,
    brandId: brand,
    origin: "competitor",
    angle: row.angle,
    hookType: row.hookType,
    format: row.format,
    proofType: row.proofType,
    offer: "",
    cta: "",
    visualStyle: "",
    platform: "",
    emotion: "",
    productName: "",
    claim: "",
    text: row.text,
  }));
  const owned = [
    ...[0, 1, 2, 3].map((index) => own(index, "curiosity")),
    ...[0, 1, 2, 3].map((index) => own(index, "offer")),
  ];
  assert.deepEqual(whitespaceAngles([...competitors, ...owned]), ["unboxing"]);
  const clusters = clusterBy(competitors.map((item) => ({ id: item.id, angle: item.angle })), "angle");
  assert.equal(clusters.find((group) => group.key === "unboxing")?.ids.length, 2);

  const nearCopy: ObservedCreative = {
    ...competitors[0]!,
    id: "draft-copy",
    origin: "generated",
    text: competitors[0]!.text,
  };
  const relation = classifyAgainst(nearCopy, competitors);
  assert.equal(relation.relation, "too_close_to_competitor");
  assert.equal(NEURAL_EMBEDDING.status, "NOT_CONNECTED");

  const product = {
    id: "prod-1",
    name: "North Soap",
    description: "",
    allowedClaims: "washes hands",
    prohibitedClaims: "cures eczema",
  };
  const before = rankOpportunities({
    organizationId: org,
    brandId: brand,
    brain: brain(),
    products: [product],
    creatives: [...competitors, ...owned],
    patterns: [],
    rejections: [],
  });
  const discovered = before.find((draft) => draft.hypothesisId === "discovered:unboxing");
  assert.ok(discovered);
  assert.equal(discovered.evidenceBasis, "market");
  assert.ok(discovered.supportingCreativeIds.includes("market-unbox-1"));
  const explained = explainOpportunity(discovered);
  assert.match(explained.whatIsHappening, /competitor/);
  assert.ok(explained.evidence.length > 0);
  const discoveredDecision = decide(opportunityGate, discovered.gateInput);
  assert.notEqual(discoveredDecision.decision, "AUTO_APPROVE");
  assert.ok(questionRegistry().some((question) => question.id === "opportunity_gate" && question.version === "v2"));

  const rankOf = (drafts: typeof before, id: string) => drafts.findIndex((draft) => draft.hypothesisId === id);
  assert.ok(rankOf(before, "offer") < rankOf(before, "curiosity"));

  const copiedLine = before.find((draft) => draft.hypothesisId === "demonstration");
  assert.ok(copiedLine);
  const copyingCompetitors = competitors.map((item, index) =>
    index === 0 ? { ...item, text: `They posted our line: ${copiedLine.hookDirection}` } : item,
  );
  const blocked = rankOpportunities({
    organizationId: org,
    brandId: brand,
    brain: brain(),
    products: [product],
    creatives: copyingCompetitors,
    patterns: [],
    rejections: [],
  }).find((draft) => draft.hypothesisId === "demonstration");
  assert.ok(blocked);
  assert.equal(decide(opportunityGate, blocked.gateInput).decision, "REJECT");

  const angles = before.map((draft) => draft.angle);
  assert.equal(new Set(angles).size, angles.length);

  const briefBefore = buildBrief({
    opportunity: before.find((draft) => draft.hypothesisId === "curiosity")!,
    brain: brain(),
    patterns: [],
    rejections: [],
    observations: competitors.map((item) => ({ id: item.id, text: item.text })),
  });
  assert.equal(briefBefore.learningNotes.length, 0);

  const script = `North Soap washes hands. ${briefBefore.hook}`;
  const textGate = assessCopy({
    text: script,
    productName: "North Soap",
    allowedClaims: "washes hands",
    prohibitedClaims: "cures eczema",
    requiredDisclaimers: "",
    wordsToAvoid: "",
    hook: briefBefore.hook,
    cta: "Shop",
  });
  assert.equal(textGate.decision.decision, "AUTO_APPROVE");
  const vision = decide(visualQa, {
    available: false,
    logoPresent: null,
    logoMatchProbability: null,
    paletteMatch: null,
    productMatch: null,
    claimDetected: null,
    claimSupported: null,
    toneFit: null,
  });
  assert.equal(vision.decision, "HUMAN_REVIEW");
  assert.equal(routeApproval(textGate.decision.decision, vision.decision), "HUMAN_REVIEW");

  const wrongLogo = decide(visualQa, {
    available: true,
    logoPresent: false,
    logoMatchProbability: 0.1,
    paletteMatch: 0.2,
    productMatch: false,
    claimDetected: null,
    claimSupported: null,
    toneFit: 0.4,
  });
  assert.equal(wrongLogo.decision, "REJECT");
  assert.equal(routeApproval("AUTO_APPROVE", wrongLogo.decision), "REJECT");

  const asset = ingestComposedText("creative-1", script);
  assert.equal(asset.status, "stored");
  assert.equal(asset.contentHash, ingestComposedText("creative-1", script).contentHash);
  assert.notEqual(asset.contentHash, ingestComposedText("creative-1", `${script} changed`).contentHash);

  const experiment = designExperiment({
    angle: "curiosity",
    productName: "North Soap",
    audience: brain().targetCustomers,
  });
  assert.match(experiment.hypothesis, /CTR/);
  assert.equal(experiment.successMetric, "ctr");
  assert.doesNotMatch(experiment.expectedLearning, /will win|guaranteed/i);

  const observations: PerformanceRow[] = owned.map((item) => ({
    creativeId: item.id,
    organizationId: org,
    brandId: brand,
    impressions: 1000,
    clicks: item.angle === "curiosity" ? 80 : 20,
    conversions: item.angle === "curiosity" ? 8 : 2,
    spendCents: 1000,
    revenueCents: item.angle === "curiosity" ? 4000 : 800,
  }));
  const queue = createJobQueue();
  let stored: LearnedPattern[] = [];
  const first = queue.enqueue("learning.update", learningJobKey("obs-1"), { brandId: brand });
  const duplicate = queue.enqueue("learning.update", learningJobKey("obs-1"), { brandId: brand });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  queue.drain(
    {
      "learning.update": () => {
        throw new Error("transient");
      },
    },
    0,
  );
  assert.equal(queue.jobs[0]?.status, "retry");
  const retried = queue.drain(
    {
      "learning.update": () => {
        stored = learnPatterns({ organizationId: org, brandId: brand, creatives: owned, observations });
      },
    },
    1000,
  );
  assert.equal(retried[0]?.status, "succeeded");
  assert.ok(stored.length > 0);

  const dead = createJobQueue();
  dead.enqueue("learning.update", "boom", {}, 2);
  dead.drain({ "learning.update": () => { throw new Error("no"); } }, 0);
  dead.drain({ "learning.update": () => { throw new Error("no"); } }, 1000);
  assert.equal(dead.jobs[0]?.status, "dead");

  const curiosity = stored.find((pattern) => pattern.attribute === "angle" && pattern.value === "curiosity" && pattern.metric === "ctr");
  const pair = stored.find((pattern) => pattern.attribute === "angle+hookType" && pattern.value === "curiosity+curiosity" && pattern.metric === "ctr");
  assert.ok(curiosity);
  assert.equal(curiosity.state, "VALIDATED");
  assert.ok(pair);
  assert.equal(pair.brandId, brand);

  const foreign: LearnedPattern = { ...curiosity, brandId: "brand-other" };
  assert.throws(
    () =>
      rankOpportunities({
        organizationId: org,
        brandId: brand,
        brain: brain(),
        products: [product],
        creatives: owned,
        patterns: [foreign],
        rejections: [],
      }),
    /Tenant scope/,
  );

  const after = rankOpportunities({
    organizationId: org,
    brandId: brand,
    brain: brain(),
    products: [product],
    creatives: [...competitors, ...owned],
    patterns: stored,
    rejections: [],
  });
  assert.ok(rankOf(after, "curiosity") < rankOf(after, "offer"));
  const next = after.find((draft) => draft.hypothesisId === "curiosity");
  assert.ok(next);
  assert.ok(next.historicalEvidence > 0);
  const briefAfter = buildBrief({
    opportunity: next,
    brain: brain(),
    patterns: stored,
    rejections: [],
  });
  assert.ok(briefAfter.learningNotes.some((note) => note.includes("angle=curiosity")));
  assert.ok(briefAfter.learningNotes.some((note) => note.includes("angle+hookType=curiosity+curiosity")));
  const nextScript = `${script}\n${briefAfter.learningNotes[0]}`;
  assert.notEqual(nextScript, script);

  const report = calibrationReport([
    { probability: curiosity ? 0.8 : 0, outcome: true },
    { probability: 0.2, outcome: false },
  ]);
  assert.equal(report.appliedToThresholds, false);
  assert.ok(report.bins.some((bin) => bin.count > 0));

  const missing = INTEGRATIONS.filter((item) => item.status === "NOT_CONNECTED").map((item) => item.id);
  assert.ok(missing.includes("ad_library"));
  assert.ok(missing.includes("meta_publish"));
  assert.ok(missing.includes("performance_feed"));
  assert.equal(INTEGRATIONS.find((item) => item.id === "lexical_similarity")?.status, "AVAILABLE");
});
