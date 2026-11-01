import assert from "node:assert/strict";
import test from "node:test";
import { emptyBrain } from "./brain.ts";
import { buildBrief } from "./brief/engine.ts";
import type { ObservedCreative, PerformanceRow } from "./domain.ts";
import { embeddingProviderState, retrieveSimilar, testEmbedding, type EmbeddingVector } from "./embeddings/provider.ts";
import { clusterCreatives, clusterWhitespace } from "./intelligence/cluster.ts";
import { decide } from "./jev/engine.ts";
import { duplicateRisk, publishingReadiness } from "./jev/guards.ts";
import { learnPatterns } from "./learning/engine.ts";
import { collectAdLibrarySource, dedupeCreatives, normalizeRecord, type RawMarketRecord } from "./market/pipeline.ts";
import { rankOpportunities } from "./opportunity/engine.ts";
import { acceptPerformanceEvent } from "./performance/normalize.ts";
import { publishWithProvider } from "./publishing/provider.ts";
import { createRateLimit } from "./security/limits.ts";
import { createMemoryObjectStore, objectStorageStatus, safeStorageKey } from "./storage/object-store.ts";

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
    format: "short_ugc",
    proofType: "demonstration",
    offer: "",
    cta: "Shop",
    visualStyle: "",
    platform: "manual",
    emotion: "",
    productName: "North Soap",
    claim: "",
    text: `${angle} for North Soap`,
  };
}

function vector(x: number, y: number): EmbeddingVector {
  return { provider: "test-embedding", model: "test-only", kind: "test", dimensions: 2, values: [x, y] };
}

test("stored evidence changes the next brief after the worker learns", async () => {
  const logo = createMemoryObjectStore();
  const stored = logo.put({
    organizationId: org,
    brandId: brand,
    key: "brand/logo.png",
    mimeType: "image/png",
    bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]),
  });
  assert.equal(stored.lifecycle, "stored");
  assert.equal(logo.get("other-org", "brand/logo.png"), null);
  assert.throws(() => safeStorageKey("../secret"), /not allowed/);
  const signed = logo.sign(org, "brand/logo.png", 0, 1000);
  assert.ok(signed);
  assert.equal(logo.open(signed.token, 500)?.checksum, stored.checksum);
  assert.equal(logo.open(signed.token, 1000), null);
  assert.equal(objectStorageStatus().status, "RETIRED");

  const raw: RawMarketRecord = {
    id: "raw-1",
    organizationId: org,
    brandId: brand,
    source: "manual",
    externalId: "ad-1",
    url: "",
    collectedAt: 0,
    publishedAt: null,
    advertiser: "Other Soap",
    platform: "manual",
    mediaType: "video",
    text: "Watch the box open. North Soap is not this advertiser.",
    angle: "unboxing",
    hook: "Watch the box open",
  };
  const first = normalizeRecord(raw);
  const second = normalizeRecord({ ...raw, id: "raw-2" });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const deduped = dedupeCreatives([first.creative, second.creative]);
  assert.equal(deduped.kept.length, 1);
  assert.equal(deduped.duplicates.length, 1);
  const library = collectAdLibrarySource();
  assert.equal(library.status, "NOT_CONNECTED");
  assert.equal(library.records.length, 0);

  const probe = testEmbedding("north soap unboxing");
  assert.equal(probe.kind, "test");
  const hits = retrieveSimilar(vector(1, 0), [
    { id: "same", brandId: brand, vector: vector(0.9, 0.1) },
    { id: "foreign", brandId: "brand-2", vector: vector(1, 0) },
    { id: "far", brandId: brand, vector: vector(0, 1) },
  ], brand, 5, 0.8);
  assert.deepEqual(hits.map((hit) => hit.id), ["same"]);
  assert.throws(() => retrieveSimilar({ ...probe, kind: "lexical", provider: "lexical-hash-v1" }, [], brand), /not semantic/);
  assert.equal(embeddingProviderState({}).status, "NOT_CONNECTED");

  const members = [
    { id: "c1", origin: "competitor" as const, angle: "unboxing", vector: vector(1, 0) },
    { id: "c2", origin: "competitor" as const, angle: "unboxing", vector: vector(0.95, 0.05) },
    { id: "own", origin: "own" as const, angle: "offer", vector: vector(0, 1) },
  ];
  const clusters = clusterCreatives(members, 0.8);
  assert.ok(clusterWhitespace(clusters, members).includes("unboxing"));

  const brain = emptyBrain();
  brain.positioning = "A direct offer for people comparing price.";
  const owned = ["curiosity", "curiosity", "curiosity", "curiosity", "offer", "offer", "offer", "offer"].map((angle, index) =>
    creative(`c-${index}`, angle),
  );
  const before = rankOpportunities({ organizationId: org, brandId: brand, brain, products: [], creatives: owned, patterns: [], rejections: [] });
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
  // The learning update runs once, as the worker's learning handler runs it. The queue that ran it is the Postgres worker, which has its own tests.
  const learned = learnPatterns({ organizationId: org, brandId: brand, creatives: owned, observations });
  const after = rankOpportunities({ organizationId: org, brandId: brand, brain, products: [], creatives: owned, patterns: learned, rejections: [] });
  const beforeCuriosity = before.find((item) => item.angle === "curiosity")?.expectedValue ?? 0;
  const afterCuriosity = after.find((item) => item.angle === "curiosity")?.expectedValue ?? 0;
  assert.ok(afterCuriosity > beforeCuriosity);
  const winner = after[0];
  assert.ok(winner);
  const brief = buildBrief({ opportunity: winner, brain, patterns: learned, rejections: [] });
  assert.ok(brief.learningNotes.length > 0 || brief.why.length > 0);
  assert.match(JSON.stringify(brief), /curiosity/i);

  const published = publishWithProvider({ organizationId: org, brandId: brand, creativeId: "c-0", platform: "meta" });
  assert.equal(published.status, "NOT_CONNECTED");
  assert.equal(published.externalId, null);
  assert.equal(decide(publishingReadiness, { providerConnected: false, creativeApproved: true, policyAllowsAutoPublish: true }).decision, "REJECT");
  assert.notEqual(decide(publishingReadiness, { providerConnected: true, creativeApproved: true, policyAllowsAutoPublish: true }).decision, "AUTO_APPROVE");
  assert.equal(decide(duplicateRisk, { relation: "too_close_to_competitor" }).decision, "REJECT");

  const row = {
    externalId: "evt-1",
    creativeId: "c-0",
    impressions: null,
    reach: null,
    clicks: 4,
    conversions: null,
    spendCents: 100,
    revenueCents: null,
    currency: "USD",
    timezone: "America/New_York",
    observedOn: "2026-10-01",
  };
  const storedEvent = acceptPerformanceEvent([], row);
  assert.equal(storedEvent.status, "stored");
  if (storedEvent.status === "stored") assert.equal(storedEvent.metrics.ctr, null);
  assert.equal(acceptPerformanceEvent([row], row).status, "duplicate");
  assert.equal(acceptPerformanceEvent([row], { ...row, clicks: 9 }).status, "conflict");
  assert.equal(acceptPerformanceEvent([], { ...row, externalId: "evt-2", currency: "" }).status, "rejected");

  const limit = createRateLimit(2, 1000);
  assert.equal(limit.allow(org, 0), true);
  assert.equal(limit.allow(org, 10), true);
  assert.equal(limit.allow(org, 20), false);
});
