import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetCacheKey, type AssetSpec } from "../contracts/assets.ts";
import { newId } from "../contracts/ids.ts";
import { routes, type RouteTable } from "../config/routes.ts";
import type { HttpResponse } from "../gateway/types.ts";
import { createAssetRouter, type ProduceInput, type RouterSignals, type RouterSettings } from "./router.ts";
import { memoryAssetCache, type AssetCache } from "./cache.ts";
import { memoryProviderStats } from "./stats.ts";
import { memoryBreakerStore } from "./breaker.ts";
import { defaultRouterSettings } from "./router.ts";
import { memoryBucketStore } from "./buckets.ts";
import { memoryMediaStore } from "./adapter.ts";
import { videoProfilesFromListing } from "./providers/openrouterVideo.ts";
import { assetSpec, base64, fakeClock, fixture, gatewayFor, json, ledgerWithReservation, mp3Bytes, pngBytes, raw, routesWith, scripted, WORKSPACE, type Reply } from "./test/recorded.ts";
import { routeCacheKey } from "./cache.ts";
import { authorizeSubmit } from "./ledger-steps.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const VEO = "google/veo-3.1";
const SEED = "bytedance/seedance-2.0";
const KLING_ID = `openrouter:${KLING}`;
const VEO_ID = `openrouter:${VEO}`;

const target = (model: string, priceKey: "kling_v3_standard" | "veo_3_1_fast" | "seedance_2_5") => ({
  provider: "openrouter",
  model,
  priceKey,
  verified: false,
});
const VIDEO_TARGETS = [target(KLING, "kling_v3_standard"), target(VEO, "veo_3_1_fast"), target(SEED, "seedance_2_5")];
const KLING_TARGET = target(KLING, "kling_v3_standard");
const videoTable: RouteTable = routesWith("video.cinematic", VIDEO_TARGETS, routes.table);

/** Quality makes Kling first, then Veo, then Seedance, so the order under test is the scored order and not chance. */
const QUALITY: Record<string, number> = { [KLING]: 0.9, [VEO]: 0.5, [SEED]: 0.1 };
const signals: RouterSignals = {
  qualityScore: (route) => QUALITY[route.model] ?? null,
  passRate: () => null,
};

const profiles = videoProfilesFromListing(fixture("video-models.json")).profiles;

const pending = (jobId: string): HttpResponse => json(200, { id: jobId, status: "in_progress" });
const accepted = (jobId: string): HttpResponse => json(200, { id: jobId, status: "pending" });
const completed = (jobId: string, cost: number): HttpResponse =>
  json(200, { id: jobId, status: "completed", unsigned_urls: [`https://openrouter.ai/api/v1/videos/${jobId}/content?index=0`], usage: { cost } });

/** The submit endpoint is shared by every video model, so the reply is chosen by the model in the body. */
function submitFor(queues: Record<string, Array<HttpResponse | Error>>): Reply {
  return (request) => {
    const model = (JSON.parse(String(request.body)) as { model: string }).model;
    const queue = queues[model];
    if (!queue || queue.length === 0) throw new Error(`no reply for ${model}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error(`no reply for ${model}`);
    if (next instanceof Error) throw next;
    return next;
  };
}

type HarnessOptions = {
  script?: Record<string, Reply | Reply[]>;
  table?: RouteTable;
  keys?: Record<string, string>;
  reservationUsd?: number;
  signals?: RouterSignals;
  settings?: Partial<RouterSettings>;
  cache?: AssetCache;
  clock?: ReturnType<typeof fakeClock>;
};

async function harness(options: HarnessOptions = {}) {
  const clock = options.clock ?? fakeClock();
  const script = scripted(options.script ?? {});
  const gateway = gatewayFor(script.transport, { ...(options.keys ? { keys: options.keys } : {}), routes: options.table ?? videoTable });
  const { ledger, reservationId } = await ledgerWithReservation(options.reservationUsd ?? 10);
  const cache = options.cache ?? memoryAssetCache();
  const stats = memoryProviderStats();
  const breakers = memoryBreakerStore();
  const buckets = memoryBucketStore();
  const media = memoryMediaStore();
  const router = createAssetRouter({
    gateway,
    ledger,
    cache,
    stats,
    breakers,
    buckets,
    media,
    videoProfiles: profiles,
    signals: options.signals ?? signals,
    ...(options.settings ? { settings: options.settings } : {}),
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
  return { router, ledger, cache, stats, breakers, buckets, media, clock, requests: script.requests, reservationId, input };
}

function posts(requests: { method: string; url: string }[]): number {
  return requests.filter((request) => request.method === "POST" && request.url.endsWith("/videos")).length;
}

describe("routing and fallback", () => {
  it("runs the best scored target first, retries a rate limit on it, then falls back when its retries are used up", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [json(429, {}), json(429, {}), json(429, {})], [VEO]: [accepted("job-veo")] }),
        "GET /api/v1/videos/job-veo": completed("job-veo", 0.4),
      },
    });
    const spec = assetSpec();
    const report = await h.router.produce(h.input(spec));

    assert.equal(report.outcome.status, "done");
    if (report.outcome.status !== "done") return;
    assert.equal(report.outcome.asset.providerId, VEO_ID);
    assert.equal(report.outcome.asset.costUsd, 0.4);

    const klingSubmits = h.requests.filter((request) => request.method === "POST" && String(request.body).includes(KLING));
    assert.equal(klingSubmits.length, 3, "three submits on the first target, the threshold's maxAttempts");
    assert.deepEqual(h.clock.sleeps, [1000, 2000], "exponential backoff between the three submits");

    assert.equal(report.decisions[0]?.chose, KLING_ID, "the decision names the scored winner");
    assert.equal(report.decisions[0]?.alternatives.length, 3);
    assert.match(report.decisions[0]?.reason ?? "", /left out of the mean, not 0 or 1/);
    assert.equal(report.decisions[1]?.chose, VEO_ID, "the fallback is a decision too");
    assert.deepEqual(
      report.attempts.map((attempt) => [attempt.providerId, attempt.outcome]),
      [
        [KLING_ID, "provider_failure"],
        [KLING_ID, "provider_failure"],
        [KLING_ID, "provider_failure"],
        [VEO_ID, "success"],
      ],
    );

    // Each submit is its own ledger entry (Bible 14.1). The first is keyed by the cache key; the retries carry an attempt suffix.
    const klingRows = (await h.ledger.listEntries(h.reservationId)).filter((row) => row.provider === "openrouter" && row.model === KLING);
    assert.equal(klingRows.length, 3, "one ledger entry per submit");
    assert.deepEqual(
      klingRows.map((row) => [row.actualUsd, row.settlement]),
      [
        [0, "confirmed_absent"],
        [0, "confirmed_absent"],
        [0, "confirmed_absent"],
      ],
      "each rate-limited submit is confirmed absent: the provider refused it before any job id, so it costs nothing",
    );
    const klingEntry = await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID));
    assert.equal(klingEntry?.actualUsd, 0, "the first submit's entry is keyed by the cache key");
    assert.equal(klingEntry?.settlement, "confirmed_absent");
    const veoEntry = await h.ledger.getEntryByKey(assetCacheKey(spec, VEO_ID));
    assert.equal(veoEntry?.actualUsd, 0.4);
    assert.equal(veoEntry?.idempotencyKey, assetCacheKey(spec, VEO_ID), "the cache key is the idempotency key");
  });

  it("a timed-out job with no bill is unsettled: no retry, and no fallback to the next provider", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")], [VEO]: [accepted("job-veo")] }),
        "GET /api/v1/videos/job-kling": pending("job-kling"),
      },
    });
    const spec = assetSpec();
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "unsettled");
    if (report.outcome.status === "unsettled") assert.equal(report.outcome.providerId, KLING_ID);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1, "one submit: no retry and no submit to the next provider");
    const timeout = report.attempts.find((attempt) => attempt.providerId === KLING_ID);
    assert.equal(timeout?.errorKind, "timeout");
    assert.ok(h.clock.sleeps.length >= 100, "the poll waited until the poll deadline (the generation lease)");
    assert.equal((await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID)))?.settlement, undefined, "the job stays unsettled");
    assert.equal(await h.cache.get(WORKSPACE, assetCacheKey(spec, KLING_ID)), null, "nothing is cached");
  });

  it("a content refusal goes back to the planner: no retry and no fallback", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [json(400, { error: "Refused by content moderation policy" })], [VEO]: [accepted("job-veo")] }) },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "failed");
    if (report.outcome.status === "failed") {
      assert.equal(report.outcome.providerId, KLING_ID);
      assert.equal(report.outcome.error.kind, "content_policy");
    }
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1, "no second submit and no veo call");
  });

  it("an invalid input goes back to the planner: no retry and no fallback", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [json(400, fixture("video-400-unsupported.json"))], [VEO]: [accepted("job-veo")] }),
      },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "failed");
    if (report.outcome.status === "failed") assert.equal(report.outcome.error.kind, "invalid_input");
    assert.equal(h.requests.length, 1);
  });

  it("an unrecognised refusal (403) is ambiguous: the submit stays unsettled, with no retry and no fallback", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [json(403, {})], [VEO]: [accepted("job-veo")] }), "GET /api/v1/videos/job-veo": completed("job-veo", 0.5) },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "unsettled", "only rate_limit, invalid_input and content_policy are definitive refusals");
    assert.equal(report.attempts.filter((attempt) => attempt.providerId === KLING_ID).length, 1, "one submit, no retry");
    assert.equal(h.requests.filter((request) => request.method === "POST" && String(request.body).includes(VEO)).length, 0, "no fallback");
  });

  it("an ambiguous server error is not retried and not fallen back from: the submit stays unsettled and its entry is held", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [json(503, {}), accepted("job-kling")], [VEO]: [accepted("job-veo")] }),
      },
    });
    const spec = assetSpec();
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "unsettled");
    if (report.outcome.status === "unsettled") {
      assert.equal(report.outcome.providerId, KLING_ID);
      assert.equal(report.outcome.idempotencyKey, assetCacheKey(spec, KLING_ID));
    }
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1, "one submit: no retry, and no submit to the next provider");
    assert.deepEqual(h.clock.sleeps, [], "no backoff, because nothing was retried");
    const held = await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID));
    assert.equal(held?.settlement, undefined, "the submit may have been billed, so it is not settled");
    assert.equal(held?.actualUsd, undefined, "no estimate is booked as the actual");
    assert.equal(held?.reservedUsd, 0.63);
  });

  it("a rate-limited submit is settled absent before its retry, and the retry is sent under a new attempt key", async () => {
    const spec = assetSpec();
    const clock = fakeClock();
    const settlementAtBackoff: Array<string | undefined> = [];
    const probe: { harness?: Awaited<ReturnType<typeof harness>> } = {};
    const h = await harness({
      clock: {
        ...clock,
        sleep: async (ms: number) => {
          // The backoff sits between the refused submit's settlement and its retry, so the settlement is visible here.
          settlementAtBackoff.push((await probe.harness?.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID)))?.settlement);
          await clock.sleep(ms);
        },
      },
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [json(429, {}), accepted("job-kling")] }) },
    });
    probe.harness = h;
    const submitted = await h.router.submit(h.input(spec));
    assert.equal(submitted.step.status, "submitted");
    assert.deepEqual(settlementAtBackoff, ["confirmed_absent"], "the refused submit is settled absent before the retry");
    assert.deepEqual(clock.sleeps, [1000], "the backoff waits inside submit, before the retry");
    const refused = await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID));
    assert.equal(refused?.actualUsd, 0);
    assert.equal(refused?.settlement, "confirmed_absent");
    if (submitted.step.status !== "submitted") return;
    assert.equal(submitted.step.job.attemptOnTarget, 2);
    assert.equal(submitted.step.job.idempotencyKey, `${assetCacheKey(spec, KLING_ID)}|attempt2`, "the retry is a new key on the ledger");
    assert.equal(h.requests.filter((request) => request.method === "POST" && String(request.body).includes(KLING)).length, 2);
  });
});

describe("cache", () => {
  it("a repeat of the same spec is a cache hit at $0: no call, no new ledger row, recorded as a hit", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    const spec = assetSpec();
    const first = await h.router.produce(h.input(spec));
    assert.equal(first.outcome.status, "done");
    const callsAfterFirst = h.requests.length;
    const firstEntry = await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID));

    const second = await h.router.produce(h.input(spec));
    assert.equal(second.outcome.status, "done");
    if (second.outcome.status !== "done") return;
    assert.equal(second.outcome.asset.cacheHit, true);
    assert.equal(second.outcome.asset.costUsd, 0);
    assert.equal(second.outcome.asset.savedUsd, 0.6125);
    assert.equal(second.outcome.asset.submits, 0);
    assert.equal(h.requests.length, callsAfterFirst, "a hit sends nothing");
    assert.equal((await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID)))?.entryId, firstEntry?.entryId);
    assert.equal((await h.cache.hits(WORKSPACE)).length, 1);
  });

  it("a different prompt is a different key, so it is not a hit", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    await h.router.produce(h.input(assetSpec({ prompt: "A bowl of soup." })));
    const other = await h.router.produce(h.input(assetSpec({ prompt: "A loaf of bread." })));
    assert.equal(other.outcome.status, "done");
    assert.equal(posts(h.requests), 2);
  });

  it("another workspace never hits this workspace's asset", async () => {
    const cache = memoryAssetCache();
    const first = await harness({
      cache,
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    await first.router.produce(first.input(assetSpec()));
    const key = assetCacheKey(assetSpec(), KLING_ID);
    assert.equal(await cache.get("org_2", key), null);
  });
});

describe("budget and connection", () => {
  it("a refused budget makes no call and writes no ledger row", async () => {
    const h = await harness({ reservationUsd: 0.1, script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }) } });
    const spec = assetSpec();
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "refused");
    assert.equal(h.requests.length, 0);
    assert.equal(await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID)), null);
  });

  it("with no connected provider, nothing is sent and the reasons say why", async () => {
    const h = await harness({ keys: {}, script: {} });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "not_connected");
    if (report.outcome.status === "not_connected") assert.equal(report.outcome.reasons.length, 3);
    assert.equal(h.requests.length, 0);
  });

  it("a capability with no routed model is not connected, and sends nothing", async () => {
    const h = await harness({ table: routes.table, script: {} });
    const report = await h.router.produce(h.input(assetSpec({ modelClass: "avatar" })));
    assert.equal(report.outcome.status, "not_connected");
    if (report.outcome.status === "not_connected") assert.match(report.outcome.reasons.join(" "), /avatar/);
    assert.equal(h.requests.length, 0);
  });

  it("an avatar route with a model reports NOT_CONNECTED from its adapter, and sends nothing", async () => {
    const table = routesWith("avatar", [{ provider: "openrouter", model: "heygen/avatar-iv", priceKey: "heygen_avatar_iv", verified: false }], routes.table);
    const h = await harness({ table, script: {} });
    const report = await h.router.produce(h.input(assetSpec({ modelClass: "avatar" })));
    assert.equal(report.outcome.status, "not_connected");
    if (report.outcome.status === "not_connected") assert.match(report.outcome.reasons.join(" "), /NOT_CONNECTED/);
    assert.equal(h.requests.length, 0);
  });

  it("a duplicate key is refused without a second call", async () => {
    const single = routesWith("video.cinematic", [KLING_TARGET], routes.table);
    const h = await harness({
      table: single,
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    const spec = assetSpec();
    const first = await h.router.produce(h.input(spec));
    assert.equal(first.outcome.status, "done");
    // A second router with an empty cache, so the call is not a hit and reaches the ledger's duplicate check.
    const idle = scripted({});
    const again = await createAssetRouter({
      gateway: gatewayFor(idle.transport, { routes: single }),
      ledger: h.ledger,
      cache: memoryAssetCache(),
      stats: memoryProviderStats(),
      breakers: memoryBreakerStore(),
      buckets: memoryBucketStore(),
      media: memoryMediaStore(),
      videoProfiles: profiles,
      signals,
      now: h.clock.now,
      sleep: h.clock.sleep,
    }).produce(h.input(spec));
    assert.equal(again.outcome.status, "duplicate");
    assert.equal(idle.requests.length, 0, "the duplicate is never sent");
  });

  it("a duplicate key whose entry is still unsettled is unsettled, and no provider call is made", async () => {
    const single = routesWith("video.cinematic", [KLING_TARGET], routes.table);
    const h = await harness({ table: single, script: {} });
    const spec = assetSpec();
    const key = assetCacheKey(spec, KLING_ID);
    const earlier = await authorizeSubmit(h.ledger, {
      reservationId: h.reservationId,
      stage: "produce_shot",
      provider: "openrouter",
      model: KLING,
      estimateUsd: 0.63,
      idempotencyKey: key,
      at: new Date(h.clock.now()).toISOString(),
    });
    if (earlier.status !== "authorized") assert.fail("the earlier submit should be authorized");
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "unsettled", "the earlier submit may have been billed, so it is not sent again");
    if (report.outcome.status === "unsettled") {
      assert.equal(report.outcome.providerId, KLING_ID);
      assert.equal(report.outcome.idempotencyKey, key);
      assert.equal(report.outcome.ledgerEntryId, earlier.entry.entryId);
    }
    assert.equal(h.requests.length, 0, "no provider call is made");
  });
});

describe("concurrency buckets and the breaker", () => {
  it("a full bucket sends the job to the next target", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [VEO]: [accepted("job-veo")] }),
        "GET /api/v1/videos/job-veo": completed("job-veo", 0.5),
      },
    });
    for (let i = 0; i < 10; i += 1) assert.equal(await h.buckets.tryAcquire(KLING_ID, 10), true);
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "done");
    if (report.outcome.status === "done") assert.equal(report.outcome.asset.providerId, VEO_ID);
    assert.equal(posts(h.requests), 1, "nothing was sent to the full bucket");
  });

  it("with every bucket full the job is queued, and nothing is sent", async () => {
    const single = routesWith("video.cinematic", [KLING_TARGET], routes.table);
    const h = await harness({ table: single, script: {} });
    for (let i = 0; i < 10; i += 1) await h.buckets.tryAcquire(KLING_ID, 10);
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "queued");
    assert.equal(h.requests.length, 0);
  });

  it("trips after the failure share is over the limit, skips the provider while open, and recovers after the skip", async () => {
    let healthy = false;
    // Three failed submits make the window; the minimum sample is lowered to 3 so this one request can trip it. The failures are
    // rate limits: they retry and then fall back, where a server error would stop the stage as ambiguous (Bible 10.4).
    const breaker = { ...defaultRouterSettings().breaker, minSample: 3 };
    const h = await harness({
      settings: { breaker },
      script: {
        "POST /api/v1/videos": (request) => {
          const model = (JSON.parse(String(request.body)) as { model: string }).model;
          if (model === KLING) return healthy ? accepted("job-kling") : json(429, {});
          return accepted("job-veo");
        },
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.63),
        "GET /api/v1/videos/job-veo": completed("job-veo", 0.5),
      },
    });

    const first = await h.router.produce(h.input(assetSpec({ prompt: "First prompt." })));
    assert.equal(first.outcome.status, "done");
    if (first.outcome.status === "done") assert.equal(first.outcome.asset.providerId, VEO_ID);
    const klingSubmitsAfterFirst = h.requests.filter((request) => request.method === "POST" && String(request.body).includes(KLING)).length;
    assert.equal(klingSubmitsAfterFirst, 3);

    const second = await h.router.produce(h.input(assetSpec({ prompt: "Second prompt." })));
    assert.equal(second.outcome.status, "done");
    if (second.outcome.status === "done") assert.equal(second.outcome.asset.providerId, VEO_ID);
    assert.match(second.decisions[0]?.reason ?? "", /circuit open/, "the open provider is named in the reason");
    assert.equal(
      h.requests.filter((request) => request.method === "POST" && String(request.body).includes(KLING)).length,
      klingSubmitsAfterFirst,
      "nothing was sent to the open provider",
    );

    healthy = true;
    h.clock.advance(600_001);
    const third = await h.router.produce(h.input(assetSpec({ prompt: "Third prompt." })));
    assert.equal(third.outcome.status, "done");
    // The skip has ended, so Kling is eligible and scored again. Its 7-day reliability now holds the outage (0 of 3), so
    // Veo can outscore it; that is the scorer working, not the breaker. The test checks eligibility, not the choice.
    assert.doesNotMatch(third.decisions[0]?.reason ?? "", /circuit open/);
    assert.ok(third.decisions[0]?.alternatives.some((alternative) => alternative.option === KLING_ID), "Kling is scored again");
  });
});

describe("scoring", () => {
  it("names the unknown dimensions and keeps every score within [0, 1]", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.63),
      },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    const decision = report.decisions[0];
    assert.ok(decision);
    assert.match(decision.reason, /unknown and left out of the mean, not 0 or 1: .*reliability/);
    for (const alternative of decision.alternatives) assert.ok(alternative.score >= 0 && alternative.score <= 1);
  });
});

describe("image routes", () => {
  it("stores the decoded image through the media store and records the bill from usage.cost", async () => {
    const answer = { created: 1748372400, data: [{ b64_json: base64(pngBytes()), media_type: "image/png" }], usage: { cost: 0.04 } };
    const h = await harness({
      table: routes.table,
      script: { "POST /api/v1/images": json(200, answer) },
    });
    const spec = assetSpec({ modelClass: "image.keyframe", durationMs: 1000 });
    const report = await h.router.produce(h.input(spec));
    assert.equal(report.outcome.status, "done");
    if (report.outcome.status !== "done") return;
    assert.equal(report.outcome.asset.providerId, "openrouter:bytedance-seed/seedream-4.5");
    assert.equal(report.outcome.asset.costUsd, 0.04);
    assert.match(report.outcome.asset.uri, /^memory:\/\/org_1\//);
    assert.equal(h.media.objects.size, 1);
  });
});

/** A speech answer as OpenRouter documents audio output: a stream with the audio in base64 chunks, the generation id, and [DONE]. */
function speechStream(audio: Uint8Array, generationId = "gen-speech-1"): Reply {
  const events = [
    `data: ${JSON.stringify({ id: generationId, choices: [{ index: 0, delta: { audio: { data: base64(audio.subarray(0, 1000)) } } }] })}`,
    "",
    `data: ${JSON.stringify({ id: generationId, choices: [{ index: 0, delta: { audio: { data: base64(audio.subarray(1000)) } } }] })}`,
    "",
    "data: [DONE]",
    "",
  ];
  return raw(200, new TextEncoder().encode(events.join("\n")), { "content-type": "text/event-stream" });
}

describe("speech voices (Bible 10.4): the voice is part of the cache key", () => {
  const SPEECH_PATH = "POST /api/v1/chat/completions";
  const STATS_PATH = "GET /api/v1/generation";
  const SPEECH_MODEL = "test/eleven-v4";
  const SPEECH_ID = `openrouter:${SPEECH_MODEL}`;
  const speechTable = () => routesWith("tts", [{ provider: "openrouter", model: SPEECH_MODEL, priceKey: "eleven_v4", verified: false }], routes.table);
  const answer = () => speechStream(mp3Bytes());
  const billed = (totalCost: number) => json(200, { data: { id: "gen-speech-1", total_cost: totalCost } });

  it("the voice is part of the cache key: a take cached for one voice is a hit for that voice only, and another voice is a call", async () => {
    const h = await harness({ table: speechTable(), script: { [SPEECH_PATH]: [answer()], [STATS_PATH]: billed(0.002) } });
    const spec = assetSpec({ modelClass: "tts", prompt: "Two scoops, one sentence.", durationMs: 1000 });
    const speak = (voiceId: string) => ({ ...h.input(spec), stage: "voice", voiceId, voiceProvider: "test" });
    const calls = () => h.requests.filter((request) => request.method === "POST" && request.url.endsWith("/chat/completions")).length;
    // A take already cached for voice_a (the first write wins, Bible 5.2).
    await h.cache.put({
      workspaceId: WORKSPACE,
      cacheKey: routeCacheKey(spec, SPEECH_ID, { voiceId: "voice_a" }),
      providerId: SPEECH_ID,
      modelClass: "tts",
      uri: "memory://org_1/take-voice-a",
      costUsd: 0.01,
      mediaType: "audio/mpeg",
      storedAt: "2026-10-14T10:00:00.000Z",
    });

    const same = await h.router.produce(speak("voice_a"));
    assert.equal(same.outcome.status, "done");
    if (same.outcome.status === "done") assert.equal(same.outcome.asset.cacheHit, true);
    assert.equal(calls(), 0, "the cached voice is a hit at $0: nothing is sent");

    await h.router.produce(speak("voice_b"));
    assert.equal(calls(), 1, "the same text in another voice is a call, not a cache hit");
    assert.equal((await h.cache.hits(WORKSPACE)).length, 1, "only voice_a's hit is recorded");
    assert.equal((await h.ledger.listEntries(h.reservationId)).length, 1, "one ledger row for voice_b's call, and none for the hit");
  });

  it("the key names the voice for a speech spec only, and is unchanged for every other spec", () => {
    const speech = assetSpec({ modelClass: "tts", prompt: "Hello there." });
    const video = assetSpec({ modelClass: "video.cinematic", prompt: "A slow push-in." });
    assert.notEqual(routeCacheKey(speech, "openrouter:test", { voiceId: "a" }), routeCacheKey(speech, "openrouter:test", { voiceId: "b" }));
    assert.equal(routeCacheKey(speech, "openrouter:test", { voiceId: null }) === routeCacheKey(speech, "openrouter:test", { voiceId: "a" }), false);
    assert.equal(routeCacheKey(video, "openrouter:test", { voiceId: "a" }), assetCacheKey(video, "openrouter:test"));
  });

  it("a speech take is settled to its generation's bill, and its generation id is read back on the ledger entry", async () => {
    const h = await harness({ table: speechTable(), script: { [SPEECH_PATH]: [answer()], [STATS_PATH]: billed(0.0031) } });
    const spec = assetSpec({ modelClass: "tts", prompt: "Settled by its bill.", durationMs: 1000 });
    const report = await h.router.produce({ ...h.input(spec), stage: "voice", voiceId: "voice_a", voiceProvider: "test" });
    assert.equal(report.outcome.status, "done");
    if (report.outcome.status === "done") assert.equal(report.outcome.asset.costUsd, 0.0031);
    const [entry] = await h.ledger.listEntries(h.reservationId);
    assert.equal(entry?.settlement, "billed");
    assert.equal(entry?.actualUsd, 0.0031, "the bill, not the estimate");
    assert.equal(entry?.providerRef, "gen-speech-1", "the generation id is recorded (contract v9)");
  });

  it("a speech take whose bill cannot be read is unsettled: held at its reservation, with its generation id kept for the reconciler", async () => {
    const h = await harness({ table: speechTable(), script: { [SPEECH_PATH]: [answer()], [STATS_PATH]: json(404, { error: "not yet" }) } });
    const spec = assetSpec({ modelClass: "tts", prompt: "The stats lag.", durationMs: 1000 });
    const report = await h.router.produce({ ...h.input(spec), stage: "voice", voiceId: "voice_a", voiceProvider: "test" });
    assert.equal(report.outcome.status, "unsettled", "no estimate is booked as the cost: the submit is unsettled");
    const [entry] = await h.ledger.listEntries(h.reservationId);
    assert.equal(entry?.settlement, undefined);
    assert.equal(entry?.actualUsd, undefined);
    assert.equal(entry?.reservedUsd, entry?.estimateUsd, "the call stays held at its reservation");
    assert.equal(entry?.providerRef, "gen-speech-1");
    const readBack = await h.ledger.getEntryByKey(entry?.idempotencyKey ?? "");
    assert.equal(readBack?.providerRef, "gen-speech-1", "read back from the store");
  });

  it("a voice of another vendor is never sent to this speech model", async () => {
    const h = await harness({ table: speechTable(), script: { [SPEECH_PATH]: [answer()], [STATS_PATH]: billed(0.002) } });
    const spec = assetSpec({ modelClass: "tts", prompt: "Wrong vendor.", durationMs: 1000 });
    const report = await h.router.produce({ ...h.input(spec), stage: "voice", voiceId: "voice_a", voiceProvider: "elevenlabs" });
    assert.equal(report.outcome.status, "not_connected");
    assert.equal(h.requests.filter((request) => request.url.endsWith("/chat/completions")).length, 0, "nothing is sent");
  });
});
