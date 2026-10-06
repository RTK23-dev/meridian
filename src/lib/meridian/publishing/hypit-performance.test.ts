import assert from "node:assert/strict";
import test from "node:test";
import { buildBrief } from "../brief/engine.ts";
import type { BrainSlice, LearnedPattern, ObservedCreative, PerformanceRow } from "../domain.ts";
import { executeJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";
import { learnPatterns } from "../learning/engine.ts";
import { rankOpportunities } from "../opportunity/engine.ts";
import { planHypitTestPerformance, persistHypitTestPerformance, type HypitPerformanceReceipt } from "./hypit-performance.ts";

const org = "org-live";
const brand = "brand-live";
const PUBLISH_ID = "test:hypit/org-live/brand-live/652c10dba9c86c6bcc86df9b88f7bbf70f567eabec4c18c85457aa36c602d78e.mp4";
const SHA = "daaff4d5d84675a0d70f78c4fb13a60828626de2640bd1126c0780a3aec63e9c";
const HYPIT_JOB = "bld_20261006T070619745Z_B3ADAF5010";

function receipt(overrides: Partial<HypitPerformanceReceipt> = {}): HypitPerformanceReceipt {
  return {
    status: "TEST_PUBLISHED",
    provider: "test",
    organizationId: org,
    brandId: brand,
    externalId: PUBLISH_ID,
    hypitJobId: HYPIT_JOB,
    sha256: SHA,
    jevDecisionId: "dec-live",
    briefId: "brief-live",
    storageKey: "hypit/org-live/brand-live/652c10dba9c86c6bcc86df9b88f7bbf70f567eabec4c18c85457aa36c602d78e.mp4",
    ...overrides,
  };
}

function creative(id: string, angle: string): ObservedCreative {
  return {
    id,
    organizationId: org,
    brandId: brand,
    origin: "generated",
    angle,
    hookType: angle === "offer" ? "offer" : "problem",
    format: angle === "offer" ? "static" : "short_ugc",
    proofType: angle,
    offer: "",
    cta: "See the bar",
    visualStyle: "",
    platform: "paid_social",
    emotion: "",
    productName: "North bar",
    claim: "",
    text: `${angle} ${id}`,
  };
}

function row(creativeId: string, clicks: number): PerformanceRow & { external_id: string; source: string; platform: string } {
  return {
    creativeId,
    organizationId: org,
    brandId: brand,
    impressions: 1000,
    clicks,
    conversions: Math.round(clicks / 10),
    spendCents: 1000,
    revenueCents: clicks * 50,
    external_id: `prior:${creativeId}`,
    source: "test:performance",
    platform: "test",
  };
}

const hypit = creative("creative-hypit-live", "demonstration");
const priors = [
  creative("c-demonstration-0", "demonstration"),
  creative("c-demonstration-1", "demonstration"),
  ...[0, 1, 2, 3].map((index) => creative(`c-offer-${index}`, "offer")),
];
const priorRows = [
  row("c-demonstration-0", 80),
  row("c-demonstration-1", 80),
  ...[0, 1, 2, 3].map((index) => row(`c-offer-${index}`, 20)),
];

function brain(): BrainSlice {
  return {
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
}

test("published Hypit test performance is learned into the next brief once", async () => {
  const state = {
    observations: priorRows.map((item) => ({ ...item })),
    jobs: [] as string[],
    patterns: [] as LearnedPattern[],
  };
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("insert into performance_observations")) {
        assert.equal(values[4], "test");
        assert.equal(values[11], "test:performance");
        state.observations.push({
          creativeId: String(values[3]),
          organizationId: org,
          brandId: brand,
          impressions: Number(values[5]),
          clicks: Number(values[6]),
          conversions: Number(values[7]),
          spendCents: Number(values[8]),
          revenueCents: Number(values[9]),
          external_id: String(values[13]),
          source: "test:performance",
          platform: "test",
        });
        return [];
      }
      if (text.includes("insert into jobs")) {
        state.jobs.push(String(values[3]));
        assert.match(String(values[4]), /test:performance/);
        assert.match(String(values[4]), /"synthetic":true/);
        return [];
      }
      if (text.includes("delete from learned_patterns")) {
        state.patterns = [];
        return [];
      }
      if (text.includes("insert into learned_patterns")) {
        state.patterns.push({
          organizationId: String(values[1]),
          brandId: String(values[2]),
          attribute: String(values[3]),
          value: String(values[4]),
          metric: String(values[5]) as LearnedPattern["metric"],
          lift: Number(values[6]),
          sampleSize: Number(values[7]),
          baseline: Number(values[8]),
          observed: Number(values[9]),
          impressions: Number(values[10]),
          summary: String(values[11]),
          state: String(values[12]) as LearnedPattern["state"],
          clicks: Number(values[13]),
          conversions: Number(values[14]),
          spendCents: Number(values[15]),
          revenueCents: Number(values[16]),
          scope: "brand",
        });
        return [];
      }
      if (text.includes("from creative_records")) {
        return [...priors, hypit].map((item) => ({
          id: item.id,
          organization_id: item.organizationId,
          brand_id: item.brandId,
          origin: item.origin,
          angle: item.angle,
          hook_type: item.hookType,
          format: item.format,
          proof_type: item.proofType,
          offer: item.offer,
          cta: item.cta,
          visual_style: item.visualStyle,
          platform: item.platform,
          emotion: item.emotion,
          product_name: item.productName,
          claim: item.claim,
          raw_text: item.text,
        }));
      }
      if (text.includes("from performance_observations")) {
        return state.observations.map((item) => ({
          creative_id: item.creativeId,
          organization_id: item.organizationId,
          brand_id: item.brandId,
          impressions: item.impressions,
          clicks: item.clicks,
          conversions: item.conversions,
          spend_cents: item.spendCents,
          revenue_cents: item.revenueCents,
        }));
      }
      return [];
    },
    { query: async () => [] },
  ) as Sql;
  const existing = priorRows.map((item) => ({
    externalId: item.external_id,
    creativeId: item.creativeId,
    impressions: item.impressions,
    reach: null,
    clicks: item.clicks,
    conversions: item.conversions,
    spendCents: item.spendCents,
    revenueCents: item.revenueCents,
    currency: "USD",
    timezone: "UTC",
    observedOn: "2026-01-01",
  }));
  const request = {
    receipt: receipt(),
    creative: hypit,
    observedOn: "2026-01-02",
    impressions: 1000,
    clicks: 80,
    conversions: 8,
    spendCents: 1000,
    revenueCents: 4000,
    existing,
  };
  const beforePatterns = learnPatterns({
    organizationId: org,
    brandId: brand,
    creatives: priors,
    observations: priorRows,
  });
  const before = rankOpportunities({
    organizationId: org,
    brandId: brand,
    brain: brain(),
    products: [{ id: "prod", name: "North bar", description: "", allowedClaims: "lathers", prohibitedClaims: "cures" }],
    creatives: priors,
    patterns: beforePatterns,
    rejections: [],
  });
  const beforeDemo = before.find((item) => item.hypothesisId === "demonstration");
  assert.ok(beforeDemo);
  assert.equal(beforeDemo.historicalEvidence, 0);
  const beforeBrief = buildBrief({ opportunity: beforeDemo, brain: brain(), patterns: beforePatterns, rejections: [] });
  assert.equal(beforeBrief.learningNotes.some((note) => note.includes("angle=demonstration")), false);

  const first = await persistHypitTestPerformance(sql, request, "actor-live");
  const replay = await persistHypitTestPerformance(sql, { ...request, existing: [...existing, first.stored ? first.record.event : existing[0]] }, "actor-live");
  assert.equal(first.stored, true);
  assert.equal(first.duplicate, false);
  assert.equal(replay.stored, true);
  assert.equal(replay.duplicate, true);
  if (!first.stored || !replay.stored) return;
  assert.equal(first.record.externalId, `${PUBLISH_ID}:day`);
  assert.equal(first.record.source, "test:performance");
  assert.equal(first.record.platform, "test");
  assert.equal(first.record.synthetic, true);
  assert.equal(first.record.jevDecisionId, "dec-live");
  assert.equal(first.record.briefId, "brief-live");
  assert.equal(first.record.hypitJobId, HYPIT_JOB);
  assert.equal(first.record.sha256, SHA);
  assert.equal(state.observations.filter((item) => item.external_id === first.record.externalId).length, 1);
  assert.equal(state.jobs.length, 1);
  const learned = await executeJob(sql, {
    id: "learn-hypit",
    organization_id: org,
    brand_id: brand,
    job_type: "learning.update",
    payload: JSON.stringify({ organizationId: org, source: "test:performance" }),
    attempts: 0,
    max_attempts: 3,
  });
  assert.match(learned, /^patterns:/);
  const demo = state.patterns.find((pattern) => pattern.attribute === "angle" && pattern.value === "demonstration" && pattern.metric === "ctr");
  assert.ok(demo);
  assert.ok(demo.lift > 0);
  assert.equal(demo.impressions, 3000);
  const after = rankOpportunities({
    organizationId: org,
    brandId: brand,
    brain: brain(),
    products: [{ id: "prod", name: "North bar", description: "", allowedClaims: "lathers", prohibitedClaims: "cures" }],
    creatives: [...priors, hypit],
    patterns: state.patterns,
    rejections: [],
  });
  const afterDemo = after.find((item) => item.hypothesisId === "demonstration");
  assert.ok(afterDemo);
  assert.ok(afterDemo.historicalEvidence > beforeDemo.historicalEvidence);
  const afterBrief = buildBrief({ opportunity: afterDemo, brain: brain(), patterns: state.patterns, rejections: [] });
  assert.ok(afterBrief.learningNotes.some((note) => note.includes("angle=demonstration")));
  assert.ok(afterBrief.learningNotes.some((note) => note.includes("vs baseline")));
});

test("an unpublished Hypit asset cannot receive performance", () => {
  const base = {
    creative: hypit,
    observedOn: "2026-01-02",
    impressions: 1000,
    clicks: 80,
    conversions: 8,
    spendCents: 1000,
    revenueCents: 4000,
    existing: [],
  };
  assert.equal(planHypitTestPerformance({ ...base, receipt: null }).stored, false);
  assert.equal(planHypitTestPerformance({ ...base, receipt: receipt({ status: "failed" }) }).stored, false);
});

test("another tenant cannot attach performance to this receipt", () => {
  assert.throws(
    () =>
      planHypitTestPerformance({
        receipt: receipt({ organizationId: "org-2" }),
        creative: hypit,
        observedOn: "2026-01-02",
        impressions: 1000,
        clicks: 10,
        conversions: 1,
        spendCents: 100,
        revenueCents: 100,
        existing: [],
      }),
    /Tenant scope violation/,
  );
});
