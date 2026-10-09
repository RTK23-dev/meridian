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
import { aggregateResearchPatterns } from "./research/patterns.ts";
import { validateResearchAnalysis } from "./research/schema.ts";
import { collectMetaAdLibrary } from "./providers/meta-research.ts";
import { analyzeResearchTranscript, researchAnalysisKey } from "./research/analyzer.ts";
import { isMp4, metaSnapshotVideoUrl } from "./research/media.ts";
import { transcribeVideo } from "./research/transcription.ts";
import { handoffToHypit, memoryHypitLedger } from "./hypit/handoff.ts";
import { buildFixtureClip } from "./video/inspect.ts";
import { loadReusableResearchAnalysis } from "./research/store.ts";

const org = "org-acceptance";
const brand = "brand-acceptance";

test("JEV Research validates typed, evidence-backed analyses and flags uncertain results", () => {
  const parsed = validateResearchAnalysis({
    topic: { value: "hand care", confidence: 0.88, evidence: ["seg-1"] },
    openingMove: { value: "problem", confidence: 0.83, evidence: ["seg-1"] },
    hookMechanism: { value: "pain_point", confidence: 0.81, evidence: ["seg-1"] },
    hook: { value: "Dry hands after washing?", confidence: 0.92, evidence: ["seg-1"] },
    structure: { value: "problem_solution", confidence: 0.78, evidence: ["seg-1", "seg-2"] },
    evidenceOffered: { value: "demonstration", confidence: 0.7, evidence: ["seg-2"] },
    emotionalAppeal: { value: "relief", confidence: 0.64, evidence: ["seg-1"] },
    adviceSpecificity: { value: "actionable", confidence: 0.71, evidence: ["seg-2"] },
    cta: { value: "shop_now", confidence: 0.87, evidence: ["seg-3"] },
    segments: [
      { id: "seg-1", text: "Dry hands after washing?", startMs: 0, endMs: 1800, role: "hook", confidence: 0.92 },
      { id: "seg-2", text: "Try this unscented soap.", startMs: 1800, endMs: 4100, role: "advice", confidence: 0.7 },
      { id: "seg-3", text: "Shop now.", startMs: 4100, endMs: 5000, role: "cta", confidence: 0.87 },
    ],
    claims: [],
  });
  assert.equal(parsed.reviewRequired, true);
  assert.equal(parsed.schemaVersion, "jev.research-ad.v2");
  assert.throws(() => validateResearchAnalysis({ ...parsed, openingMove: { value: "invented", confidence: 0.8, evidence: ["seg-1"] } }));
});

test("JEV Research patterns are corpus counts with provenance, not performance claims", () => {
  const make = (adId: string, hookMechanism: string) => ({ adId, analysisId: `analysis-${adId}`, analysis: validateResearchAnalysis({
    topic: { value: "hand care", confidence: 0.9, evidence: ["seg-1"] },
    openingMove: { value: "problem", confidence: 0.8, evidence: ["seg-1"] },
    hookMechanism: { value: hookMechanism, confidence: 0.8, evidence: ["seg-1"] },
    hook: { value: "Dry hands?", confidence: 0.9, evidence: ["seg-1"] },
    structure: { value: "problem_solution", confidence: 0.8, evidence: ["seg-1"] },
    evidenceOffered: { value: "demonstration", confidence: 0.8, evidence: ["seg-1"] },
    emotionalAppeal: { value: "relief", confidence: 0.8, evidence: ["seg-1"] },
    adviceSpecificity: { value: "actionable", confidence: 0.8, evidence: ["seg-1"] },
    cta: { value: "shop_now", confidence: 0.8, evidence: ["seg-1"] },
    segments: [{ id: "seg-1", text: "Dry hands?", startMs: null, endMs: null, role: "hook", confidence: 0.8 }],
    claims: [],
  }) });
  const patterns = aggregateResearchPatterns([make("ad-a", "pain_point"), make("ad-b", "pain_point"), make("ad-c", "curiosity")]);
  const repeatedHook = patterns.find((pattern) => pattern.dimension === "hookMechanism" && pattern.value === "pain_point");
  assert.equal(repeatedHook?.sampleCount, 2);
  assert.equal(repeatedHook?.state, "INFERRED", "a corpus count of model labels is an inference, not an observation");
  assert.deepEqual(repeatedHook?.exampleAdIds, ["ad-a", "ad-b"]);
  assert.deepEqual(repeatedHook?.exampleAnalysisIds, ["analysis-ad-a", "analysis-ad-b"]);
  assert.match(repeatedHook?.summary ?? "", /frequency only/i);
  const opportunities = rankOpportunities({
    organizationId: org, brandId: brand, brain: brain(), products: [], creatives: [], patterns: [], rejections: [],
    researchPatterns: patterns,
  });
  const researchOpportunity = opportunities.find((candidate) => candidate.hypothesisId.startsWith("research:"));
  assert.ok(researchOpportunity);
  assert.equal(researchOpportunity.researchSampleCount, 2);
  assert.equal(researchOpportunity.researchState, "INFERRED");
  assert.ok(researchOpportunity.evidence.some((item) => item.source === "jev_research"));
  const brief = buildBrief({ opportunity: researchOpportunity, brain: brain(), patterns: [], rejections: [], observations: [] });
  assert.ok(brief.why.some((item) => /frequency only/i.test(item)));
});

test("external advertising evidence flows through JEV Research, opportunity, decision, brief, and Hypit", async () => {
  const collected = await collectMetaAdLibrary({
    token: "research-token",
    searchTerms: "hand soap",
    country: "US",
    transport: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: [
        { id: "external-1", page_name: "Soap One", ad_snapshot_url: "https://www.facebook.com/ads/archive/?id=external-1", ad_creative_bodies: ["Dry hands? Try gentle soap. Shop now."] },
        { id: "external-2", page_name: "Soap Two", ad_snapshot_url: "https://www.facebook.com/ads/archive/?id=external-2", ad_creative_bodies: ["Dry hands? Use gentle soap. Shop now."] },
      ] }),
    }),
  });
  assert.equal(collected.status, "CONNECTED");
  if (collected.status !== "CONNECTED") return;
  const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const transcript = await transcribeVideo(videoBytes, {
    env: {},
    extractAudio: async () => ({ bytes: new Uint8Array([1, 2, 3]), durationMs: 5000 }),
    transcribeLocal: async () => ({
      text: "Dry hands? Try gentle soap. Shop now.",
      segments: [
        { start: 0, end: 1.5, text: "Dry hands?" },
        { start: 1.5, end: 4, text: "Try gentle soap." },
        { start: 4, end: 5, text: "Shop now." },
      ],
    }),
  });
  assert.equal(transcript.status, "transcribed");
  if (transcript.status !== "transcribed") return;
  const analyzed = await analyzeResearchTranscript({
    sourceId: collected.ads[0]!.externalId,
    transcript: transcript.transcript,
    segments: transcript.segments,
    provider: "fixture-chat",
    model: "fixture-model",
    complete: async (request) => ({
      ok: true,
      provider: "fixture-chat",
      model: request.model,
      content: JSON.stringify({
        topic: { value: "hand care", confidence: 0.91, evidence: ["t1"] },
        openingMove: { value: "problem", confidence: 0.9, evidence: ["t1"] },
        hookMechanism: { value: "pain_point", confidence: 0.9, evidence: ["t1"] },
        hook: { value: "Dry hands?", confidence: 0.92, evidence: ["t1"] },
        structure: { value: "problem_solution", confidence: 0.88, evidence: ["t1", "t2"] },
        evidenceOffered: { value: "none", confidence: 0.8, evidence: ["t2"] },
        emotionalAppeal: { value: "relief", confidence: 0.84, evidence: ["t1"] },
        adviceSpecificity: { value: "general", confidence: 0.8, evidence: ["t2"] },
        cta: { value: "shop_now", confidence: 0.9, evidence: ["t3"] },
        segments: transcript.segments.map((segment) => ({ ...segment, role: segment.id === "t1" ? "hook" : segment.id === "t3" ? "cta" : "advice", confidence: 0.9 })),
        claims: [],
      }),
      latencyMs: 8,
      tokens: 400,
    }),
  });
  assert.equal(analyzed.status, "analyzed");
  if (analyzed.status !== "analyzed") return;
  const patterns = aggregateResearchPatterns(collected.ads.map((ad) => ({ adId: ad.externalId, analysis: analyzed.analysis })));
  const competitors: ObservedCreative[] = collected.ads.map((ad) => ({
    ...own(0, "soap demonstration"), id: ad.externalId, origin: "competitor", hookType: "pain_point", format: "video", proofType: "problem_solution", text: ad.copy,
  }));
  const ranked = rankOpportunities({
    organizationId: org,
    brandId: brand,
    brain: { ...brain(), problems: "hand care dry hands", positioning: "gentle hand soap", valueProposition: "North Soap is gentle hand soap." },
    products: [{ id: "product-1", name: "North Soap", description: "", allowedClaims: "gentle hand soap", prohibitedClaims: "cures eczema" }],
    creatives: competitors,
    patterns: [],
    rejections: [],
    researchPatterns: patterns,
  });
  const opportunity = ranked.find((candidate) => candidate.researchSampleCount === 2);
  assert.ok(opportunity, "collected advertising patterns become a JEV opportunity");
  assert.equal(opportunity.researchSampleCount, 2);
  const jev = decide(opportunityGate, opportunity.gateInput);
  assert.notEqual(jev.decision, "REJECT");
  const brief = buildBrief({ opportunity, brain: brain(), patterns: [], rejections: [] });
  assert.ok(brief.why.some((item) => /frequency only/i.test(item)));
  const handoff = await handoffToHypit({
    organizationId: org,
    brandId: brand,
    product: "North Soap",
    objective: "Test an original hand-care video built from observed advertising patterns.",
    angle: brief.angle,
    visualDirection: "Use original product shots and no unsupported claims.",
    tone: "plain",
    cta: "Shop now",
    format: "short_ugc",
    aspectRatio: "9:16",
    durationSeconds: 10,
    requiredClaims: [],
    prohibitedClaims: ["cures eczema"],
    brandAssets: [],
    briefId: "brief-research-e2e",
    decision: {
      id: "decision-research-e2e", organizationId: org, brandId: brand, questionId: jev.questionId,
      policyVersion: jev.policyVersion, decision: jev.decision,
      reviewerDecision: jev.decision === "HUMAN_REVIEW" ? "approved" : "",
      reasons: jev.reasons, evidence: jev.evidence,
    },
  }, {
    env: { baseUrl: "https://hypit.example" },
    ledger: memoryHypitLedger(),
    transport: async (request) => request.url.endsWith("/artifact")
      ? { status: 200, headers: {}, body: JSON.stringify({ mime: "video/mp4", base64: Buffer.from(buildFixtureClip({ durationMs: 2500, width: 64, height: 64, frames: [] })).toString("base64"), durationMs: 2500, width: 64, height: 64 }) }
      : { status: 200, headers: {}, body: JSON.stringify({ providerJobId: "hypit-e2e", status: "succeeded" }) },
  });
  assert.equal(handoff.ok, true);
  assert.equal(handoff.job.contract.lineage.jevDecisionId, "decision-research-e2e");
  assert.equal(handoff.job.contract.lineage.briefId, "brief-research-e2e");
  assert.ok(handoff.artifactBytes?.byteLength);
});

test("Meta Ad Library collection is explicit when disconnected and bounded/deduplicated when connected", async () => {
  const disconnected = await collectMetaAdLibrary({ searchTerms: "soap", country: "US", transport: async () => { throw new Error("must not call"); } });
  assert.equal(disconnected.status, "NOT_CONNECTED");
  if (disconnected.status !== "NOT_CONNECTED") throw new Error("expected disconnected source");
  assert.deepEqual(disconnected.ads, []);

  const requests: string[] = [];
  const connected = await collectMetaAdLibrary({
    token: "secret",
    searchTerms: "soap",
    country: "US",
    limit: 1000,
    capturedAt: "2026-10-06T00:00:00.000Z",
    transport: async (request) => {
      requests.push(request.url);
      if (request.url.includes("after=cursor")) return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
      return { status: 200, headers: {}, body: JSON.stringify({ data: [
        { id: "a1", page_id: "p1", page_name: "Soap Co", ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=a1&access_token=secret", ad_creative_bodies: ["Observed copy"] },
        { id: "a1", page_id: "p1", page_name: "Soap Co", ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=a1&access_token=secret", ad_creative_bodies: ["Observed copy"] },
        { id: "bad", page_name: "Bad", ad_snapshot_url: "http://127.0.0.1/video", media_type: "VIDEO" },
      ], paging: { cursors: { after: "cursor" } } }) };
    },
  });
  assert.equal(connected.status, "CONNECTED");
  if (connected.status !== "CONNECTED") throw new Error("expected connected source");
  assert.equal(connected.ads.length, 1);
  assert.equal(connected.ads[0]?.externalId, "a1");
  assert.equal(connected.ads[0]?.capturedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(connected.ads[0]?.snapshotUrl.includes("access_token"), false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.includes("limit=25"), true);
  assert.equal(requests[0]?.includes("secret"), false);
});

test("JEV Research analysis is idempotent by source/transcript/schema/model and rejects changed evidence", async () => {
  const segments = [{ id: "t0", text: "Try this soap. Shop now.", startMs: 0, endMs: 3000, role: "other" as const, confidence: 1, state: "OBSERVED" as const }];
  const response = {
    topic: { value: "hand care", confidence: 0.9, evidence: ["t0"] },
    openingMove: { value: "problem", confidence: 0.8, evidence: ["t0"] },
    hookMechanism: { value: "pain_point", confidence: 0.8, evidence: ["t0"] },
    hook: { value: "Try this soap.", confidence: 0.9, evidence: ["t0"] },
    structure: { value: "problem_solution", confidence: 0.8, evidence: ["t0"] },
    evidenceOffered: { value: "unclear", confidence: 0.4, evidence: ["t0"] },
    emotionalAppeal: { value: "unclear", confidence: 0.4, evidence: ["t0"] },
    adviceSpecificity: { value: "not_applicable", confidence: 0.8, evidence: ["t0"] },
    cta: { value: "shop_now", confidence: 0.9, evidence: ["t0"] },
    segments,
    claims: [],
  };
  const complete = async () => ({ ok: true as const, content: JSON.stringify(response), provider: "fixture", model: "fixture-v1", latencyMs: 1, tokens: 10 });
  const result = await analyzeResearchTranscript({ sourceId: "source-a", transcript: segments[0]!.text, segments, provider: "fixture", model: "fixture-v1", complete });
  assert.equal(result.status, "analyzed");
  if (result.status !== "analyzed") throw new Error("expected analysis");
  assert.equal(result.analysis.reviewRequired, true);
  assert.equal(result.key, researchAnalysisKey({ sourceId: "source-a", transcript: segments[0]!.text, provider: "fixture", model: "fixture-v1" }));
  assert.notEqual(result.key, researchAnalysisKey({ sourceId: "source-b", transcript: segments[0]!.text, provider: "fixture", model: "fixture-v1" }));
  const fabricated = { ...response, segments: [{ ...segments[0], text: "Invented claim" }] };
  const rejected = await analyzeResearchTranscript({
    sourceId: "source-a", transcript: segments[0]!.text, segments, provider: "fixture", model: "fixture-v1",
    complete: async () => ({ ok: true, content: JSON.stringify(fabricated), provider: "fixture", model: "fixture-v1", latencyMs: 1, tokens: null }),
  });
  assert.equal(rejected.status, "failed");
});

test("stored JEV Research analysis is reusable only through its tenant, brand, ad, and video hash", async () => {
  const parameters: unknown[] = [];
  let statement = "";
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statement = strings.join(" ");
    parameters.push(...values);
    return [{
      result: JSON.stringify({ schemaVersion: "jev.research-ad.v2" }),
      cache_key: "cache-key", provider: "fixture", model: "model-1", prompt_version: "jev.research-ad.v2", latency_ms: 12, tokens: 30,
    }];
  }) as unknown as import("./learning/store.ts").Sql;
  const cached = await loadReusableResearchAnalysis(sql, { organizationId: "org-a", brandId: "brand-a", researchAdId: "ad-a", videoHash: "hash-a" });
  assert.equal(cached?.cacheKey, "cache-key");
  assert.equal(cached?.analysis.schemaVersion, "jev.research-ad.v2");
  assert.match(statement, /t\.content_hash/);
  assert.match(statement, /r\.schema_version/);
  assert.deepEqual(parameters.slice(0, 4), ["ad-a", "org-a", "brand-a", "hash-a"]);
});

test("Meta snapshot media extraction accepts only explicit public Meta-hosted video URLs", () => {
  assert.equal(metaSnapshotVideoUrl('<meta property="og:video" content="https://video.xx.fbcdn.net/creative.mp4?sig=1&amp;x=2">'), "https://video.xx.fbcdn.net/creative.mp4?sig=1&x=2");
  assert.equal(metaSnapshotVideoUrl('<video src="http://127.0.0.1/private.mp4"></video>'), null);
  assert.equal(metaSnapshotVideoUrl('<video src="https://example.com/not-meta.mp4"></video>'), null);
  assert.equal(isMp4(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])), true);
  assert.equal(isMp4(new Uint8Array([1, 2, 3, 4])), false);
});

test("JEV Research transcription is explicit, timestamped, and content-hash reusable", async () => {
  const video = new Uint8Array([1, 2, 3, 4]);
  let usedLocalRunner = false;
  const result = await transcribeVideo(video, {
    env: { WHISPERX_MODEL: "small" },
    extractAudio: async () => ({ bytes: new Uint8Array([9, 8, 7]), durationMs: 4200 }),
    transcribeLocal: async (bytes, options) => {
      usedLocalRunner = true;
      assert.deepEqual([...bytes], [9, 8, 7]);
      assert.equal(options.model, "small");
      return { text: "Dry hands? Try this soap. Shop now.", segments: [{ text: "Dry hands?", start: 0, end: 1.2 }, { text: "Try this soap. Shop now.", start: 1.2, end: 4.2 }] };
    },
  });
  assert.equal(usedLocalRunner, true);
  assert.equal(result.status, "transcribed");
  if (result.status !== "transcribed") throw new Error("expected transcript");
  assert.equal(result.provider, "local:whisperx");
  assert.equal(result.model, "small");
  assert.equal(result.contentHash.length, 64);
  assert.equal(result.segments[1]?.startMs, 1200);
  assert.equal(result.segments[1]?.endMs, 4200);
});

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
