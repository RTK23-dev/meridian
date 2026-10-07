import assert from "node:assert/strict";
import test from "node:test";
import { canRunStage, parseFactoryLevel, spendWithinCap, assertSpendCap } from "./autopilot.ts";
import { rollupCosts, withinBudget } from "./cost.ts";
import { dnaFromTranscript, decodeOk, emptyCreativeDna } from "./creative-dna.ts";
import { brandGate, claimsGate, combineGates, originalityGate, policyGate, rightsGate } from "./gates.ts";
import { adsMustPause, assertBrandInWorkspace, killSwitchCommand } from "./kill-switch.ts";
import type { Sql } from "../learning/store.ts";
import { factoryRunJobs, factoryStageAllowed, isFactoryStage } from "./pipeline.ts";
import { executeFactoryJob } from "./worker.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { weeklyStrategistReport } from "./report.ts";
import { snapshotMediaAllowed } from "./sources.ts";
import { templateFromDna, variantMatrix } from "./template.ts";
import { allocateTestBudget } from "./thompson.ts";
import { buildAdTimeline } from "./timeline.ts";
import { trendReport } from "./trends.ts";
import { winnerScore, backtestWinnerScore } from "./winner-score.ts";
import { formatYield, summarizeYields } from "./yield.ts";

test("a factory run is a job graph with tenant-scoped idempotency", () => {
  const jobs = factoryRunJobs({ organizationId: "org-1", brandId: "brand-1", runId: "run-1", niche: "skincare" });
  assert.equal(jobs.length, 13);
  assert.equal(jobs[0].dependsOnKey, null);
  assert.equal(jobs[1].dependsOnKey, "factory:brand-1:run-1:factory.discover");
  assert.ok(jobs.every((job) => job.payload.organizationId === "org-1"));
  assert.ok(isFactoryStage("factory.gate"));
  assert.equal(isFactoryStage("video.generate"), false);
  const suggest = factoryRunJobs({ organizationId: "org-1", brandId: "brand-1", runId: "run-2", niche: "skincare", level: 0 });
  assert.ok(suggest.some((job) => job.jobType === "factory.template"));
  assert.ok(suggest.every((job) => !["factory.produce", "factory.gate", "factory.review", "factory.launch"].includes(job.jobType)));
  const produce = factoryRunJobs({ organizationId: "org-1", brandId: "brand-1", runId: "run-3", niche: "skincare", level: 1 });
  assert.ok(produce.some((job) => job.jobType === "factory.review"));
  assert.ok(produce.every((job) => !["factory.launch", "factory.test", "factory.learn"].includes(job.jobType)));
  assert.equal(factoryStageAllowed(0, "factory.produce"), false);
  assert.equal(factoryStageAllowed(1, "factory.review"), true);
  assert.throws(() => factoryRunJobs({ organizationId: "", brandId: "b", runId: "r", niche: "x" }), /organization/);
});

test("persisted factory jobs cannot execute beyond their run level", async () => {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    if (strings.join(" ").includes("select id, status, niche, level")) return [{ id: "run-1", status: "running", niche: "skincare", level: 0 }];
    return [];
  }) as unknown as Sql;
  const job: ExecutableJob = {
    id: "job-1", organization_id: "org-1", brand_id: "brand-1", job_type: "factory.produce",
    payload: JSON.stringify({ runId: "run-1" }), attempts: 0, max_attempts: 3,
  };
  assert.equal(await executeFactoryJob(sql, job, { runId: "run-1" }), "skipped:above-level-0");
  assert.equal(queries.length, 1);
});

test("winner score shows a range and evidence, never a bare number", () => {
  const scored = winnerScore({
    daysRunning: 41,
    stillRunning: true,
    iterationCount: 6,
    countries: 9,
    platforms: 3,
    advertiserSurvivorRate: 0.7,
    creativeQuality: 0.8,
  });
  assert.ok(scored.score > 0.5);
  assert.ok(scored.low <= scored.score && scored.high >= scored.score);
  assert.ok(scored.evidence.some((item) => item.includes("live 41 days")));
  assert.ok(scored.evidence.some((item) => item.includes("6 variants")));
  const backtest = backtestWinnerScore([
    ...Array.from({ length: 20 }, (_, index) => ({ score: 0.9 - index * 0.01, stillLiveAfter30Days: index < 12 })),
    ...Array.from({ length: 20 }, (_, index) => ({ score: 0.2 + index * 0.01, stillLiveAfter30Days: index < 4 })),
  ]);
  assert.ok(backtest.lift != null && backtest.lift >= 1.5);
});

test("ad timelines refuse to invent first-seen when no sighting exists", () => {
  assert.equal(buildAdTimeline({ sightings: [] }), null);
  const timeline = buildAdTimeline({
    sightings: [
      { seenAt: "2026-09-01T00:00:00.000Z", platforms: ["facebook"], countries: ["US"], reachLow: 1000, reachHigh: 5000, stillRunning: true },
      { seenAt: "2026-10-01T00:00:00.000Z", platforms: ["instagram"], countries: ["US", "CA"], reachLow: 2000, reachHigh: 8000, stillRunning: true },
    ],
    siblingVariants: 3,
    now: "2026-10-07T00:00:00.000Z",
  });
  assert.ok(timeline);
  assert.equal(timeline.daysRunning, 36);
  assert.deepEqual(timeline.platforms.sort(), ["facebook", "instagram"]);
  assert.equal(timeline.siblingVariants, 3);
});

test("creative DNA is versioned and a missing transcript stays empty", () => {
  const empty = emptyCreativeDna("ad-1");
  assert.equal(empty.hook.text.value, "");
  assert.ok(decodeOk(empty));
  const dna = dnaFromTranscript({ adId: "ad-1", durationMs: 15000, transcript: "Stop scrolling. This serum is in stock.", hookType: "pattern_interrupt", format: "ugc", angle: "offer" });
  assert.equal(dna.schema, "meridian.creative-dna.v1");
  assert.ok(dna.beats.some((beat) => beat.role === "hook"));
});

test("rising concepts carry evidence and whitespace is only for unused proven concepts", () => {
  const trends = trendReport({
    thisWeek: "2026-10-06",
    prevWeek: "2026-09-29",
    brandConcepts: ["ugc testimonial"],
    ads: [
      { id: "a1", concept: "asmr unboxing", advertiser: "brand-a", week: "2026-10-06", niche: "skincare" },
      { id: "a2", concept: "asmr unboxing", advertiser: "brand-b", week: "2026-10-06", niche: "skincare" },
      { id: "a3", concept: "asmr unboxing", advertiser: "brand-a", week: "2026-09-29", niche: "skincare" },
      { id: "a4", concept: "ugc testimonial", advertiser: "brand-c", week: "2026-10-06", niche: "skincare" },
    ],
  });
  const asmr = trends.find((item) => item.concept === "asmr unboxing");
  assert.ok(asmr);
  assert.equal(asmr.momentum, "rising");
  assert.equal(asmr.whitespace, true);
  assert.ok(asmr.evidence.length > 0);
  const own = trends.find((item) => item.concept === "ugc testimonial");
  assert.equal(own?.whitespace, false);
});

test("templates drop source words and the variant matrix stays inside 5-20", () => {
  const dna = dnaFromTranscript({ adId: "winner-1", durationMs: 12000, transcript: "Secret formula from the original slogan", format: "demo" });
  const template = templateFromDna(dna);
  assert.ok(template.beats.every((beat) => !beat.voiceover.toLowerCase().includes("secret formula")));
  const variants = variantMatrix({
    hooks: ["question", "pattern interrupt"],
    ctas: ["shop", "learn"],
    presenters: ["founder"],
    lengthsMs: [9000, 15000],
    max: 10,
  });
  assert.ok(variants.length >= 5 && variants.length <= 10);
});

test("originality blocks close copies and missing evidence stays in review", () => {
  assert.equal(originalityGate({ frameHashDistance: 3, embeddingDistance: 0.4, textSimilarity: 0.1 }).result, "block");
  assert.equal(originalityGate({ frameHashDistance: null, embeddingDistance: null, textSimilarity: null }).result, "review");
  assert.equal(claimsGate({ claims: ["washes hands"], approvedClaims: ["washes hands"], bannedWords: ["cure"] }).result, "pass");
  assert.equal(claimsGate({ claims: ["cures eczema"], approvedClaims: ["washes hands"], bannedWords: [] }).result, "block");
  assert.equal(policyGate({ beforeAfter: true, personalAttribute: false, healthClaim: false, financeClaim: false }).result, "block");
  assert.equal(rightsGate({ musicLicensed: false, footageLicensed: true, aiLabeled: true }).result, "block");
  assert.equal(brandGate({ logoPresent: null, paletteMatch: null, productLooksRight: null }).result, "review");
  const combined = combineGates([
    originalityGate({ frameHashDistance: 20, embeddingDistance: 0.4, textSimilarity: 0.2 }),
    claimsGate({ claims: ["washes hands"], approvedClaims: ["washes hands"], bannedWords: [] }),
  ]);
  assert.equal(combined.result, "pass");
});

test("autopilot levels and caps refuse spend the owner did not set", () => {
  assert.equal(parseFactoryLevel(3), 3);
  assert.equal(parseFactoryLevel("nope"), null);
  assert.equal(canRunStage(0, "produce"), false);
  assert.equal(canRunStage(3, "run"), true);
  assert.equal(spendWithinCap(500, { dailyCents: 1000, totalCents: 4000 }), true);
  assert.equal(spendWithinCap(4000, { dailyCents: 1000, totalCents: 4000 }), false);
  assert.throws(() => assertSpendCap({ dailyCents: 500, totalCents: 100 }), /cannot exceed/);
});

test("a kill switch pauses every live ad in that scope", () => {
  const event = killSwitchCommand({ organizationId: "org-1", brandId: "brand-1", engage: true, actorId: "user-1", now: "2026-10-07T00:00:00.000Z" });
  assert.equal(event.scope, "brand");
  assert.equal(adsMustPause({ workspaceEngaged: false, brandEngaged: true }), true);
  assert.equal(adsMustPause({ workspaceEngaged: false, brandEngaged: false }), false);
});

test("a brand kill switch cannot target a brand in another workspace", async () => {
  let values: unknown[] = [];
  const sql = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
    values = params;
    assert.match(strings.join(" "), /organization_id =/);
    return [];
  }) as unknown as Sql;
  await assert.rejects(assertBrandInWorkspace(sql, "org-a", "brand-b"), /not owned by that workspace/);
  assert.deepEqual(values, ["brand-b", "org-a"]);
});

test("thompson sampling pauses losers only after minimum spend", () => {
  const allocation = allocateTestBudget({
    seed: "test-1",
    minSpendCents: 500,
    arms: [
      { id: "a", successes: 20, trials: 100, spendCents: 800 },
      { id: "b", successes: 1, trials: 80, spendCents: 800 },
      { id: "c", successes: 8, trials: 40, spendCents: 100 },
    ],
  });
  const loser = allocation.find((item) => item.id === "b");
  const young = allocation.find((item) => item.id === "c");
  assert.equal(loser?.pause, true);
  assert.equal(young?.pause, false);
});

test("cost per winning variant is the headline number when winners exist", () => {
  const rollup = rollupCosts({
    decodedAds: 10,
    variants: 10,
    winningVariants: 2,
    stages: [{ stage: "produce", cents: 4000, seconds: 100 }, { stage: "decode", cents: 1000, seconds: 40 }],
  });
  assert.equal(rollup.costPerWinningVariantCents, 2500);
  assert.equal(withinBudget(5000, 6000), true);
});

test("yield and snapshot rights stay explicit", () => {
  assert.equal(snapshotMediaAllowed({}), false);
  assert.equal(snapshotMediaAllowed({ RESEARCH_SNAPSHOT_MEDIA: "1" }), true);
  const summary = summarizeYields([
    { niche: "skincare", adsFound: 40, videosDownloaded: 2, transcriptsProduced: 1, analysesCompleted: 1, snapshotWithoutVideo: 38, mediaFailed: 0, snapshotMediaEnabled: false },
    { niche: "gadgets", adsFound: 10, videosDownloaded: 0, transcriptsProduced: 0, analysesCompleted: 0, snapshotWithoutVideo: 10, mediaFailed: 0, snapshotMediaEnabled: false },
  ]);
  assert.equal(summary.adsFound, 50);
  assert.equal(summary.videoHitRate, 0.04);
  assert.match(formatYield({
    niche: "skincare", adsFound: 40, videosDownloaded: 2, transcriptsProduced: 1, analysesCompleted: 1, snapshotWithoutVideo: 38, mediaFailed: 0, snapshotMediaEnabled: false,
  }), /snapshot_media=off/);
});

test("the weekly report does not invent a win", () => {
  const report = weeklyStrategistReport({
    week: "2026-10-06",
    winners: [],
    trends: [],
    queuedTemplates: [],
  });
  assert.equal(report.won.length, 0);
  assert.match(report.note, /Missing evidence stays missing/);
});
