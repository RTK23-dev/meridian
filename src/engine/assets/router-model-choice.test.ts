// The asset router with the orchestrator's model choice (Bible 10.5, contract v7). Recorded responses only; no live call.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { newId } from "../contracts/ids.ts";
import type { AssetSpec, ModelChoice } from "../contracts/assets.ts";
import { routes, type RouteTable } from "../config/routes.ts";
import type { HttpResponse } from "../gateway/types.ts";
import { parseVideoCatalog, type CatalogRead, type ModelCatalogSource } from "../gateway/catalog.ts";
import { withModelPolicy } from "../gateway/catalog-policy.ts";
import { createAssetRouter, type ProduceInput, type RouterSignals } from "./router.ts";
import { memoryAssetCache, routeCacheKey, type AssetCache } from "./cache.ts";
import { memoryProviderStats } from "./stats.ts";
import { memoryBreakerStore } from "./breaker.ts";
import { memoryBucketStore } from "./buckets.ts";
import { memoryMediaStore } from "./adapter.ts";
import { videoProfilesFromListing } from "./providers/openrouterVideo.ts";
import { assetSpec, fakeClock, fixture, gatewayFor, json, ledgerWithReservation, routesWith, scripted, WORKSPACE, type Reply } from "./test/recorded.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const WAN = "alibaba/wan-2.6";
const READ_AT = "2026-10-16T09:00:00.000Z";

/** The recorded GET /videos/models listing of the gateway's catalog tests, unverified live (gateway/test/fixtures/README.md). */
const videoListing: unknown = JSON.parse(readFileSync(new URL("../gateway/test/fixtures/openrouter-catalog-videos.json", import.meta.url), "utf8"));
const catalogEntries = parseVideoCatalog(videoListing, READ_AT).entries;

/** A catalog source over the recorded listing, counting its reads. `entries` lets a test take a model out of the catalog. */
function catalogSource(entries = catalogEntries): ModelCatalogSource & { reads: number } {
  const source = {
    reads: 0,
    async read(): Promise<CatalogRead> {
      source.reads += 1;
      return { status: "read", catalog: { readAt: READ_AT, entries, dropped: [], failed: [], videoListing } };
    },
  };
  return source;
}

/** The route table has Kling only, priced from the price table (kling_v3_standard, $0.126 per second). */
const table: RouteTable = routesWith("video.cinematic", [{ provider: "openrouter", model: KLING, priceKey: "kling_v3_standard", verified: false }], routes.table);
const signals: RouterSignals = { qualityScore: () => null, passRate: () => null };
/** The router's own profiles: the routed models of the asset router fixture (Kling is listed there). */
const routedProfiles = videoProfilesFromListing(fixture("video-models.json")).profiles;

const accepted = (jobId: string): HttpResponse => json(200, { id: jobId, status: "pending" });
const completed = (jobId: string, cost: number): HttpResponse =>
  json(200, { id: jobId, status: "completed", unsigned_urls: [`https://openrouter.ai/api/v1/videos/${jobId}/content?index=0`], usage: { cost } });

function submitFor(byModel: Record<string, HttpResponse>): Reply {
  return (request) => {
    const model = (JSON.parse(String(request.body)) as { model: string }).model;
    const reply = byModel[model];
    if (reply === undefined) throw new Error(`no reply for ${model}`);
    return reply;
  };
}

const choice = (modelId: string, source: ModelChoice["source"] = "orchestrator"): ModelChoice => ({
  provider: "openrouter",
  modelId,
  source,
  reason: "the cheapest eligible per-second price for a 5 s shot",
  catalogReadAt: READ_AT,
});

async function harness(options: {
  script: Record<string, Reply | Reply[]>;
  catalog?: ModelCatalogSource | null;
  cache?: AssetCache;
  table?: RouteTable;
  disabledFamilies?: readonly string[];
}) {
  const clock = fakeClock();
  const script = scripted(options.script);
  const gateway = gatewayFor(script.transport, { routes: options.table ?? table });
  const { ledger, reservationId } = await ledgerWithReservation(10);
  const catalog = options.catalog === null ? undefined : (options.catalog ?? catalogSource());
  const router = createAssetRouter({
    gateway,
    ledger,
    cache: options.cache ?? memoryAssetCache(),
    stats: memoryProviderStats(),
    breakers: memoryBreakerStore(),
    buckets: memoryBucketStore(),
    media: memoryMediaStore(),
    videoProfiles: routedProfiles,
    signals,
    ...(catalog === undefined ? {} : { catalog }),
    ...(options.disabledFamilies === undefined ? {} : { disabledFamilies: options.disabledFamilies }),
    now: clock.now,
    sleep: clock.sleep,
  });
  const input = (spec: AssetSpec): ProduceInput => ({
    spec,
    workspaceId: WORKSPACE,
    requestId: newId("req_"),
    reservationId,
    stage: "produce_shot",
    visualType: "cinematic",
  });
  return { router, ledger, reservationId, requests: script.requests, input };
}

const submittedModels = (requests: { method: string; url: string; body?: unknown }[]): string[] =>
  requests
    .filter((request) => request.method === "POST" && request.url.endsWith("/videos"))
    .map((request) => (JSON.parse(String(request.body)) as { model: string }).model);

describe("router with a model choice", () => {
  it("sends the call to the chosen OpenRouter model, estimates it from the catalog price, and settles to usage.cost", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [WAN]: accepted("job-wan") }), "GET /api/v1/videos/job-wan": completed("job-wan", 0.31) },
    });
    const spec = assetSpec({ durationMs: 5000, modelChoice: choice(WAN) });
    const report = await h.router.produce(h.input(spec));

    assert.equal(report.outcome.status, "done", JSON.stringify(report.outcome));
    if (report.outcome.status !== "done") return;
    assert.deepEqual(submittedModels(h.requests), [WAN], "only the chosen model is called, not the route table's Kling");
    assert.equal(report.outcome.asset.providerId, `openrouter:${WAN}`);
    assert.equal(report.outcome.asset.cacheKey, routeCacheKey(spec, `openrouter:${WAN}`, {}));
    assert.equal(report.outcome.asset.costUsd, 0.31, "the bill is OpenRouter's usage.cost, not the estimate");

    const rows = await h.ledger.listEntries(h.reservationId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, WAN);
    assert.equal(rows[0]?.estimateUsd, 0.2125, "5 s at the catalog's $0.0425 per second");
    assert.equal(rows[0]?.actualUsd, 0.31);

    const decision = report.decisions.find((item) => item.by === "director");
    assert.equal(decision?.chose, `openrouter:${WAN}`);
    assert.match(decision?.reason ?? "", /catalog price \$0\.0425 per_second \(per-video-second-1080p\)/);
  });

  it("prices a chosen model that is also routed from the catalog, not from the price table", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: accepted("job-k") }), "GET /api/v1/videos/job-k": completed("job-k", 0.7) },
    });
    const report = await h.router.produce(h.input(assetSpec({ durationMs: 5000, modelChoice: choice(KLING) })));
    assert.equal(report.outcome.status, "done");
    const rows = await h.ledger.listEntries(h.reservationId);
    assert.equal(rows[0]?.estimateUsd, 0.7, "5 s at the catalog's 1080p rate $0.14, not the price table's $0.126");
  });

  it("refuses a chosen model for a duration it does not list: it is not sent the call, and the fallback says which durations are listed", async () => {
    const h = await harness({ script: {} });
    const report = await h.router.produce(h.input(assetSpec({ durationMs: 6000, modelChoice: choice(KLING) })));
    assert.equal(report.decisions[0]?.chose, "route table for video.cinematic");
    assert.match(report.decisions[0]?.reason ?? "", /no longer fits the call \(duration_outside: 6 s is not one of the durations listed \(5, 10 s\)\)/);
    assert.deepEqual(submittedModels(h.requests), [], "a 6 s call is not sent to a model that lists 5 and 10 s");
  });

  it("falls back to the route table, and records it, when the chosen model has left the catalog", async () => {
    const catalog = catalogSource(catalogEntries.filter((entry) => entry.id !== WAN));
    const h = await harness({
      catalog,
      script: { "POST /api/v1/videos": submitFor({ [KLING]: accepted("job-k") }), "GET /api/v1/videos/job-k": completed("job-k", 0.63) },
    });
    const report = await h.router.produce(h.input(assetSpec({ durationMs: 5000, modelChoice: choice(WAN) })));
    assert.equal(report.outcome.status, "done");
    if (report.outcome.status !== "done") return;
    assert.deepEqual(submittedModels(h.requests), [KLING]);
    assert.equal(report.outcome.asset.providerId, `openrouter:${KLING}`);
    assert.equal((await h.ledger.listEntries(h.reservationId))[0]?.estimateUsd, 0.63, "the route table's price: 5 s at $0.126");
    assert.equal(catalog.reads, 1);
    const fallback = report.decisions[0];
    assert.equal(fallback?.chose, "route table for video.cinematic");
    assert.match(fallback?.reason ?? "", /no longer in the catalog for video\.cinematic/);
  });

  it("a fallback to the route table never submits to a family the plan's brand switched off, and uses the next target", async () => {
    // The orchestrator chose a model of a family the brand has switched off. The catalog the router reads is the plan's own (withModelPolicy),
    // so the choice has left it, and the route table is the fallback. Its first target is of that family and is refused; the next one is used.
    const KLING_FAMILY = "kwaivgi";
    const catalog = withModelPolicy(catalogSource(), async () => [KLING_FAMILY]);
    const h = await harness({
      table: routesWith("video.cinematic", [{ provider: "openrouter", model: KLING, priceKey: "kling_v3_standard", verified: false }, { provider: "openrouter", model: WAN, priceKey: "wan_2_6", verified: false }], routes.table),
      disabledFamilies: [KLING_FAMILY],
      catalog,
      script: { "POST /api/v1/videos": submitFor({ [WAN]: accepted("job-wan") }), "GET /api/v1/videos/job-wan": completed("job-wan", 0.2) },
    });
    const report = await h.router.produce(h.input(assetSpec({ durationMs: 5000, modelChoice: choice(KLING) })));
    assert.equal(report.outcome.status, "done", JSON.stringify(report.outcome));
    assert.deepEqual(submittedModels(h.requests), [WAN], "the switched-off target is never submitted, not on the first submit nor on a fallback");
    assert.equal(report.decisions[0]?.chose, "route table for video.cinematic");
    assert.equal(report.outcome.status === "done" ? report.outcome.asset.providerId : null, `openrouter:${WAN}`);
  });

  it("when every target of the route table is of a switched-off family, nothing is submitted and each target's reason says so", async () => {
    const h = await harness({
      table: routesWith("video.cinematic", [{ provider: "openrouter", model: KLING, priceKey: "kling_v3_standard", verified: false }, { provider: "openrouter", model: WAN, priceKey: "wan_2_6", verified: false }], routes.table),
      disabledFamilies: ["kwaivgi", "alibaba"],
      script: {},
    });
    const report = await h.router.produce(h.input(assetSpec({ durationMs: 5000 })));
    assert.equal(report.outcome.status, "unavailable", JSON.stringify(report.outcome));
    if (report.outcome.status === "unavailable") assert.match(report.outcome.reasons.join("\n"), /switched off by the model policy/);
    assert.deepEqual(submittedModels(h.requests), [], "no call is sent");
  });

  it("falls back when the chosen model no longer fits the call", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: accepted("job-k") }), "GET /api/v1/videos/job-k": completed("job-k", 0.63) },
    });
    // The recorded listing names no last frame for Wan 2.6, and this call has one: unknown does not fit.
    const spec = assetSpec({ durationMs: 5000, lastFrame: "https://cdn.example.com/b.png", modelChoice: choice(WAN) });
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "done");
    assert.deepEqual(submittedModels(h.requests), [KLING]);
    assert.match(report.decisions[0]?.reason ?? "", /no longer fits the call \(last_frame_unknown/);
  });

  it("falls back, and says so, when the runtime has no catalog", async () => {
    const h = await harness({
      catalog: null,
      script: { "POST /api/v1/videos": submitFor({ [KLING]: accepted("job-k") }), "GET /api/v1/videos/job-k": completed("job-k", 0.63) },
    });
    const report = await h.router.produce(h.input(assetSpec({ durationMs: 5000, modelChoice: choice(WAN) })));
    assert.equal(report.outcome.status, "done");
    assert.deepEqual(submittedModels(h.requests), [KLING]);
    assert.match(report.decisions[0]?.reason ?? "", /no model catalog/);
  });

  it("keeps two models' assets apart in the cache: the provider id names the chosen model", async () => {
    const cache = memoryAssetCache();
    const h = await harness({
      cache,
      script: {
        "POST /api/v1/videos": submitFor({ [WAN]: accepted("job-wan"), [KLING]: accepted("job-k") }),
        "GET /api/v1/videos/job-wan": completed("job-wan", 0.3),
        "GET /api/v1/videos/job-k": completed("job-k", 0.84),
      },
    });
    const base = assetSpec({ durationMs: 5000 });
    const lite = await h.router.produce(h.input({ ...base, modelChoice: choice(WAN) }));
    // Kling lists 5 and 10 s, so it takes this 5 s spec and a 10 s one. The cache key differs by model either way.
    assert.equal(lite.outcome.status, "done");
    const again = await h.router.produce(h.input({ ...base, modelChoice: choice(WAN) }));
    assert.equal(again.outcome.status === "done" && again.outcome.asset.cacheHit, true, "the same spec and model is a hit");
    const kling = await h.router.produce(h.input({ ...base, durationMs: 10000, modelChoice: choice(KLING) }));
    assert.equal(kling.outcome.status === "done" && kling.outcome.asset.cacheHit, false);
    assert.notEqual(
      routeCacheKey({ ...base, modelChoice: choice(WAN) }, `openrouter:${WAN}`, {}),
      routeCacheKey({ ...base, modelChoice: choice(KLING) }, `openrouter:${KLING}`, {}),
    );
  });
});

describe("router with no model choice", () => {
  it("routes exactly as before: the route table's target, the price table's estimate, and no catalog read", async () => {
    const catalog = catalogSource();
    const h = await harness({
      catalog,
      script: { "POST /api/v1/videos": submitFor({ [KLING]: accepted("job-k") }), "GET /api/v1/videos/job-k": completed("job-k", 0.63) },
    });
    const spec = assetSpec({ durationMs: 5000 });
    assert.equal(spec.modelChoice, null);
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "done");
    if (report.outcome.status !== "done") return;
    assert.equal(report.outcome.asset.providerId, `openrouter:${KLING}`);
    assert.equal(report.outcome.asset.cacheKey, routeCacheKey(spec, `openrouter:${KLING}`, {}));
    assert.equal((await h.ledger.listEntries(h.reservationId))[0]?.estimateUsd, 0.63);
    assert.equal(catalog.reads, 0, "the catalog is read only for a spec with a choice");
    assert.equal(report.decisions.length, 1);
    assert.equal(report.decisions[0]?.by, "scorer");
  });
});
