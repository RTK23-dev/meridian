import assert from "node:assert/strict";
import test from "node:test";
import type { ObservedCreative, OrganicObservationRow, PerformanceRow } from "../domain.ts";
import { learnPatterns, surfaceOfMetric } from "./engine.ts";
import { learnedWeightOf, learningScopeOf, type Concept, type LearnedRow } from "../factory/pick.ts";

// Learning per surface (NORTH_STAR section 8, item 10). A pattern learned from organic outcomes is kept apart from one learned from
// paid outcomes, and Pick applies each only to a run on the same surface.

const org = "org-1";
const brand = "brand-1";

function creative(id: string, angle: string): ObservedCreative {
  return {
    id,
    organizationId: org,
    brandId: brand,
    origin: "own",
    angle,
    hookType: angle,
    format: "ugc",
    proofType: "",
    offer: "",
    cta: "shop",
    visualStyle: "",
    platform: "meta",
    emotion: "",
    productName: "Soap",
    claim: "",
    text: `${angle} ${id}`,
  };
}

const creatives: ObservedCreative[] = [
  ...Array.from({ length: 8 }, (_, index) => creative(`curiosity-${index}`, "curiosity")),
  ...Array.from({ length: 8 }, (_, index) => creative(`offer-${index}`, "offer")),
];

/** Paid outcomes where curiosity wins on click-through and conversion. */
function paidRows(channel = ""): PerformanceRow[] {
  return creatives.map((item) => ({
    creativeId: item.id,
    organizationId: org,
    brandId: brand,
    impressions: 4000,
    clicks: item.angle === "curiosity" ? 480 : 160,
    conversions: item.angle === "curiosity" ? 40 : 12,
    spendCents: 4000,
    revenueCents: item.angle === "curiosity" ? 12000 : 4000,
    channel,
  }));
}

/** Organic outcomes where curiosity holds attention for three seconds far longer than offer does. */
function organicRows(channel = ""): OrganicObservationRow[] {
  return creatives.map((item) => ({
    creativeId: item.id,
    organizationId: org,
    brandId: brand,
    views: 1000,
    threeSecondViews: item.angle === "curiosity" ? 600 : 300,
    completionRate: 0.4,
    shares: item.angle === "curiosity" ? 60 : 10,
    channel,
  }));
}

test("each metric names its surface: click, conversion and return are paid, and retention, completion and shares are organic", () => {
  assert.equal(surfaceOfMetric("ctr"), "paid");
  assert.equal(surfaceOfMetric("cvr"), "paid");
  assert.equal(surfaceOfMetric("roas"), "paid");
  assert.equal(surfaceOfMetric("retention_3s"), "organic");
  assert.equal(surfaceOfMetric("completion_rate"), "organic");
  assert.equal(surfaceOfMetric("shares"), "organic");
  assert.equal(surfaceOfMetric("impressions"), null);
});

test("an organic win and a paid win each produce a pattern, and each pattern is labelled with its own surface", () => {
  const paid = learnPatterns({ organizationId: org, brandId: brand, creatives, observations: paidRows() });
  const organic = learnPatterns({ organizationId: org, brandId: brand, creatives, observations: [], organicObservations: organicRows() });

  const paidWin = paid.find((item) => item.attribute === "angle" && item.value === "curiosity" && item.metric === "ctr");
  assert.ok(paidWin, "a paid win produces a pattern");
  assert.equal(paidWin.surface, "paid");
  assert.ok(paid.every((item) => item.surface === "paid"), "paid observations produce no organic pattern");

  const organicWin = organic.find((item) => item.attribute === "angle" && item.value === "curiosity" && item.metric === "retention_3s");
  assert.ok(organicWin, "an organic win produces a pattern");
  assert.equal(organicWin.surface, "organic");
  assert.ok(organic.every((item) => item.surface === "organic"), "organic observations produce no paid pattern");
});

test("a mixed call labels every pattern with the surface its metric belongs to", () => {
  const mixed = learnPatterns({ organizationId: org, brandId: brand, creatives, observations: paidRows(), organicObservations: organicRows() });
  assert.ok(mixed.length > 0);
  assert.ok(mixed.every((item) => item.surface === surfaceOfMetric(item.metric)));
});

const CURIOSITY: Concept = {
  key: "ugc|curiosity|curiosity",
  label: "ugc / curiosity hook / curiosity",
  angle: "curiosity",
  hookType: "curiosity",
  format: "ugc",
};

const PAID_WIN: LearnedRow = {
  attribute: "angle",
  value: "curiosity",
  metric: "ctr",
  lift: 0.5,
  sample_size: 8,
  impressions: 32000,
  state: "VALIDATED",
  p_beat: 0.99,
  ci_low: 0.2,
  ci_high: 0.8,
  surface: "paid",
  channel: "",
};

const ORGANIC_WIN: LearnedRow = { ...PAID_WIN, metric: "retention_3s", surface: "organic" };

test("an organic run is weighted by the organic win, and a paid win does not move it", () => {
  const scope = learningScopeOf({ intent: "organic", platforms: [] });
  assert.ok(scope);
  const organic = learnedWeightOf(CURIOSITY, [ORGANIC_WIN], scope);
  assert.ok(organic.weight > 1, `the organic win raises an organic run to ${organic.weight}`);
  assert.ok(organic.notes.some((note) => /on organic/.test(note)));

  const withPaidToo = learnedWeightOf(CURIOSITY, [PAID_WIN, ORGANIC_WIN], scope);
  assert.equal(withPaidToo.weight, organic.weight, "a paid win is never applied to an organic run");
  assert.equal(learnedWeightOf(CURIOSITY, [PAID_WIN], scope).weight, 1, "a paid pattern alone leaves an organic run at one");
});

test("a paid run is weighted by the paid win, and an organic win does not move it", () => {
  const scope = learningScopeOf({ intent: "ad", platforms: [] });
  assert.ok(scope);
  assert.ok(learnedWeightOf(CURIOSITY, [PAID_WIN], scope).weight > 1);
  assert.equal(learnedWeightOf(CURIOSITY, [ORGANIC_WIN], scope).weight, 1, "an organic pattern alone leaves a paid run at one");
});

test("a run with intent both has no surface, so no learned pattern moves it", () => {
  assert.equal(learningScopeOf({ intent: "both", platforms: ["instagram"] }), null);
  assert.equal(learnedWeightOf(CURIOSITY, [PAID_WIN, ORGANIC_WIN], null).weight, 1);
});

test("a channel-specific pattern moves only a run that names its channel, and an all-channel pattern moves every run on its surface", () => {
  const tiktokWin: LearnedRow = { ...ORGANIC_WIN, channel: "tiktok" };
  const allChannels = learningScopeOf({ intent: "organic", platforms: ["youtube"] });
  assert.ok(allChannels);
  assert.equal(learnedWeightOf(CURIOSITY, [tiktokWin], allChannels).weight, 1, "a tiktok pattern does not move a youtube run");
  assert.ok(learnedWeightOf(CURIOSITY, [ORGANIC_WIN], allChannels).weight > 1, "an all-channel pattern moves a youtube run");

  const tiktokRun = learningScopeOf({ intent: "organic", platforms: ["tiktok"] });
  assert.ok(tiktokRun);
  assert.ok(learnedWeightOf(CURIOSITY, [tiktokWin], tiktokRun).weight > 1, "a tiktok pattern moves a run that names tiktok");
});
