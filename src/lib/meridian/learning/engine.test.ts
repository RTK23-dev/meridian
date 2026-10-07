import assert from "node:assert/strict";
import test from "node:test";
import type { ObservedCreative, PerformanceRow } from "../domain.ts";
import { learnPatterns } from "./engine.ts";

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

test("a 5% lift on three creatives and 300 impressions is not stored as a winner", () => {
  const creatives = [
    creative("a1", "curiosity"),
    creative("a2", "curiosity"),
    creative("a3", "curiosity"),
    creative("b1", "offer"),
    creative("b2", "offer"),
    creative("b3", "offer"),
  ];
  const observations: PerformanceRow[] = creatives.map((item) => ({
    creativeId: item.id,
    organizationId: org,
    brandId: brand,
    impressions: 300,
    clicks: item.angle === "curiosity" ? 21 : 20,
    conversions: 1,
    spendCents: 300,
    revenueCents: 300,
  }));
  const patterns = learnPatterns({ organizationId: org, brandId: brand, creatives, observations });
  assert.equal(patterns.length, 0);
});

test("a large, consistent lift is stored with a credible interval and q-value", () => {
  const creatives = [
    ...Array.from({ length: 8 }, (_, index) => creative(`win-${index}`, "curiosity")),
    ...Array.from({ length: 8 }, (_, index) => creative(`base-${index}`, "offer")),
  ];
  const observations: PerformanceRow[] = creatives.map((item) => ({
    creativeId: item.id,
    organizationId: org,
    brandId: brand,
    impressions: 4000,
    clicks: item.angle === "curiosity" ? 480 : 160,
    conversions: item.angle === "curiosity" ? 40 : 12,
    spendCents: 4000,
    revenueCents: item.angle === "curiosity" ? 12000 : 4000,
  }));
  const patterns = learnPatterns({ organizationId: org, brandId: brand, creatives, observations });
  assert.ok(patterns.length > 0);
  const curiosity = patterns.find((item) => item.attribute === "angle" && item.value === "curiosity" && item.metric === "ctr");
  assert.ok(curiosity);
  assert.ok((curiosity.pBeat ?? 0) >= 0.95);
  assert.ok(curiosity.ciLow != null && curiosity.ciHigh != null);
  assert.ok(curiosity.qValue != null && curiosity.qValue <= 0.1);
  assert.match(curiosity.summary, /P\(beat\)/);
});
