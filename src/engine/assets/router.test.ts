import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetCacheKey, type AssetSpec } from "../contracts/assets.ts";
import { sumUsd } from "../contracts/money.ts";
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
    assert.equal(report.outcome.asset.costIsEstimate, false);

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
    assert.equal(
      sumUsd(klingRows.map((row) => row.actualUsd ?? 0)),
      1.89,
      "each refused submit holds its list estimate (3 x 0.63), never under-counted",
    );
    const klingEntry = await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID));
    assert.equal(klingEntry?.actualUsd, 0.63, "the first submit's entry is keyed by the cache key");
    const veoEntry = await h.ledger.getEntryByKey(assetCacheKey(spec, VEO_ID));
    assert.equal(veoEntry?.actualUsd, 0.4);
    assert.equal(veoEntry?.idempotencyKey, assetCacheKey(spec, VEO_ID), "the cache key is the idempotency key");
  });

  it("a timeout moves to the next provider without a retry", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")], [VEO]: [accepted("job-veo")] }),
        "GET /api/v1/videos/job-kling": pending("job-kling"),
        "GET /api/v1/videos/job-veo": completed("job-veo", 0.5),
      },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "done");
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 2, "one submit per provider");
    const timeout = report.attempts.find((attempt) => attempt.providerId === KLING_ID);
    assert.equal(timeout?.errorKind, "timeout");
    assert.ok(h.clock.sleeps.length >= 100, "the poll waited until the poll deadline (the generation lease)");
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

  it("an unrecognised credential refusal moves on without a retry", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [json(403, {})], [VEO]: [accepted("job-veo")] }), "GET /api/v1/videos/job-veo": completed("job-veo", 0.5) },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "done");
    assert.equal(report.attempts.filter((attempt) => attempt.providerId === KLING_ID).length, 1, "one submit, no retry");
  });

  it("a server error is retried on the same provider and then succeeds", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [json(503, {}), accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    const report = await h.router.produce(h.input(assetSpec()));
    assert.equal(report.outcome.status, "done");
    if (report.outcome.status === "done") assert.equal(report.outcome.asset.providerId, KLING_ID);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 2);
    assert.deepEqual(h.clock.sleeps, [1000]);
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
    // Three failed submits make the window; the minimum sample is lowered to 3 so this one request can trip it.
    const breaker = { ...defaultRouterSettings().breaker, minSample: 3 };
    const h = await harness({
      settings: { breaker },
      script: {
        "POST /api/v1/videos": (request) => {
          const model = (JSON.parse(String(request.body)) as { model: string }).model;
          if (model === KLING) return healthy ? accepted("job-kling") : json(500, {});
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

describe("speech voices (Bible 10.4): the voice is part of the cache key", () => {
  const SPEECH_PATH = "POST /api/v1/audio/speech";
  const SPEECH_MODEL = "test/eleven-v4";
  const speechTable = () => routesWith("tts", [{ provider: "openrouter", model: SPEECH_MODEL, priceKey: "eleven_v4", verified: false }], routes.table);
  const answer = () => raw(200, mp3Bytes(), { "content-type": "audio/mpeg" });

  it("two voices speaking the same text do not share a cached take: each voice is a call, and the same voice again is a hit", async () => {
    const h = await harness({ table: speechTable(), script: { [SPEECH_PATH]: [answer(), answer(), answer()] } });
    const spec = assetSpec({ modelClass: "tts", prompt: "Two scoops, one sentence.", durationMs: 1000 });
    const speak = (voiceId: string) => ({ ...h.input(spec), stage: "voice", voiceId });
    const calls = () => h.requests.filter((request) => request.url.endsWith("/audio/speech")).length;

    const first = await h.router.produce(speak("voice_a"));
    assert.equal(first.outcome.status, "done");
    assert.equal(calls(), 1, "the first voice is called");

    const second = await h.router.produce(speak("voice_b"));
    assert.equal(second.outcome.status, "done");
    assert.equal(calls(), 2, "the second voice is called: the same text in another voice is not a cache hit");
    assert.equal((await h.cache.hits(WORKSPACE)).length, 0, "no hit was recorded for the other voice");

    const third = await h.router.produce(speak("voice_a"));
    assert.equal(third.outcome.status, "done");
    assert.equal(calls(), 2, "the first voice again is a cache hit at $0");
    assert.equal((await h.cache.hits(WORKSPACE)).length, 1);

    const rows = await h.ledger.listEntries(h.reservationId);
    assert.equal(rows.length, 2, "one ledger row for each voice's call, and none for the hit");
    assert.notEqual(rows[0]?.idempotencyKey, rows[1]?.idempotencyKey, "the two calls have two ledger keys");
  });

  it("the key names the voice for a speech spec only, and is unchanged for every other spec", () => {
    const speech = assetSpec({ modelClass: "tts", prompt: "Hello there." });
    const video = assetSpec({ modelClass: "video.cinematic", prompt: "A slow push-in." });
    assert.notEqual(routeCacheKey(speech, "openrouter:test", { voiceId: "a" }), routeCacheKey(speech, "openrouter:test", { voiceId: "b" }));
    assert.equal(routeCacheKey(speech, "openrouter:test", { voiceId: null }) === routeCacheKey(speech, "openrouter:test", { voiceId: "a" }), false);
    assert.equal(routeCacheKey(video, "openrouter:test", { voiceId: "a" }), assetCacheKey(video, "openrouter:test"));
  });
});
