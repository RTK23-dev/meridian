// The asynchronous path of the router (Bible 10.4, 15.2): submit returns a job, settle finishes it from the poller's answer. Every
// provider answer here is recorded (test/recorded.ts). The poll is the real video adapter's poll over the recorded GET, so the
// answer the settle sees is the one the poller would see. No test calls a live API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetCacheKey, type AssetSpec, type ProviderPoll } from "../contracts/assets.ts";
import { EngineError } from "../contracts/errors.ts";
import { newId } from "../contracts/ids.ts";
import { routes, type RouteTable } from "../config/routes.ts";
import { type AsyncAssetRouter, type ProduceInput, type RouterSignals, type RouterSettings, createAssetRouter, defaultRouterSettings } from "./router.ts";
import type { AssetJob } from "./job.ts";
import { memoryAssetCache } from "./cache.ts";
import { memoryProviderStats } from "./stats.ts";
import { memoryBreakerStore } from "./breaker.ts";
import { memoryBucketStore } from "./buckets.ts";
import { memoryMediaStore } from "./adapter.ts";
import { openRouterVideoAdapter, videoProfilesFromListing } from "./providers/openrouterVideo.ts";
import { assetSpec, fakeClock, fixture, gatewayFor, json, ledgerWithReservation, raw, routesWith, scripted, WORKSPACE, type Reply } from "./test/recorded.ts";
import { gatewayDownloader } from "../gateway/download.ts";
import { publicTestResolver } from "../gateway/test/resolver.ts";
import type { HttpRequest, HttpResponse } from "../gateway/types.ts";
import type { Gateway } from "../gateway/gateway.ts";
import type { LedgerRow } from "../budget/store.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const WAN = "alibaba/wan-2.6";
const SEED = "bytedance/seedance-2.0";
const KLING_ID = `openrouter:${KLING}`;
const WAN_ID = `openrouter:${WAN}`;

const target = (model: string, priceKey: "kling_v3_standard" | "wan_2_6" | "seedance_2_5") => ({
  provider: "openrouter",
  model,
  priceKey,
  verified: false,
});
const videoTable: RouteTable = routesWith(
  "video.cinematic",
  [target(KLING, "kling_v3_standard"), target(WAN, "wan_2_6"), target(SEED, "seedance_2_5")],
  routes.table,
);
const QUALITY: Record<string, number> = { [KLING]: 0.9, [WAN]: 0.5, [SEED]: 0.1 };
const signals: RouterSignals = { qualityScore: (route) => QUALITY[route.model] ?? null, passRate: () => null };
const profiles = videoProfilesFromListing(fixture("video-models.json")).profiles;

const accepted = (jobId: string): HttpResponse => json(200, { id: jobId, status: "pending" });
const completed = (jobId: string, cost: number): HttpResponse =>
  json(200, { id: jobId, status: "completed", unsigned_urls: [`https://openrouter.ai/api/v1/videos/${jobId}/content?index=0`], usage: { cost } });
const CONTENT = (jobId: string) => `GET /api/v1/videos/${jobId}/content`;

/** A minimal mp4: an ftyp box at byte 4, above the video floor. */
function mp4Bytes(size = 8192): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32], 0);
  return bytes;
}

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
  reservationUsd?: number;
  takes?: boolean;
  settings?: Partial<RouterSettings>;
};

async function harness(options: HarnessOptions = {}) {
  const clock = fakeClock();
  const script = scripted(options.script ?? {});
  const gateway: Gateway = gatewayFor(script.transport, { routes: options.table ?? videoTable });
  const { ledger, reservationId } = await ledgerWithReservation(options.reservationUsd ?? 10);
  const cache = memoryAssetCache();
  const stats = memoryProviderStats();
  const breakers = memoryBreakerStore();
  const buckets = memoryBucketStore();
  const media = memoryMediaStore();
  const router: AsyncAssetRouter = createAssetRouter({
    gateway,
    ledger,
    cache,
    stats,
    breakers,
    buckets,
    media,
    videoProfiles: profiles,
    signals,
    ...(options.takes ? { takes: { downloader: gatewayDownloader(gateway, { resolver: publicTestResolver }) } } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    now: clock.now,
    sleep: clock.sleep,
  });
  const input = (spec: AssetSpec, overrides: Partial<ProduceInput> = {}): ProduceInput => ({
    spec,
    workspaceId: WORKSPACE,
    requestId: newId("req_"),
    reservationId,
    stage: "produce_shot",
    visualType: "cinematic",
    ...overrides,
  });
  return { router, gateway, ledger, cache, stats, breakers, buckets, media, clock, requests: script.requests, reservationId, input };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** The finished poll of a job, from the real video adapter over the recorded GET answer. */
async function pollFor(h: Harness, job: AssetJob): Promise<ProviderPoll> {
  const route = h.gateway.routes("video.cinematic").find((candidate) => candidate.model === job.model);
  if (route === undefined) throw new Error(`no route for ${job.model}`);
  const adapter = openRouterVideoAdapter({ gateway: h.gateway, organizationId: WORKSPACE, route, profile: profiles.get(job.model) ?? null });
  return adapter.poll(job.jobRef);
}

async function rowsOf(h: Harness): Promise<string[]> {
  const rows: LedgerRow[] = await h.ledger.listEntries(h.reservationId);
  return rows.map((row) => `${row.entryId}:${row.idempotencyKey}:${row.actualUsd ?? "held"}:${row.settlement ?? "-"}`);
}

function posts(requests: HttpRequest[], model?: string): number {
  return requests.filter((request) => request.method === "POST" && (model === undefined || String(request.body).includes(model))).length;
}

describe("submit returns a job and settle finishes it", () => {
  it("submit sends one job and holds its slot; settle finishes the take and reconciles the ledger to the bill", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    const spec = assetSpec();
    const input = h.input(spec);

    const submitted = await h.router.submit(input);
    assert.equal(submitted.step.status, "submitted");
    if (submitted.step.status !== "submitted") return;
    const job = submitted.step.job;
    assert.equal(submitted.step.runAfterMs, 0, "the first poll of a fresh submit waits nothing");
    assert.equal(job.providerId, KLING_ID);
    assert.equal(job.provider, "openrouter");
    assert.equal(job.model, KLING);
    assert.equal(job.jobRef, "job-kling");
    assert.equal(job.idempotencyKey, assetCacheKey(spec, KLING_ID), "the first submit's key is the cache key");
    assert.equal(job.attemptOnTarget, 1);
    assert.equal(job.submitNumber, 1);
    assert.equal(job.targetSubmits, 1);
    assert.equal(job.targets.length, 3, "the scored targets travel with the job");
    assert.equal(posts(h.requests), 1);
    assert.equal(h.requests.filter((request) => request.method === "GET").length, 0, "submit does not poll");
    assert.equal(await h.buckets.inFlight(KLING_ID), 1, "the job holds its slot until it is settled");

    const held = await h.ledger.getEntryByKey(job.idempotencyKey);
    assert.equal(held?.actualUsd, undefined, "the submit is held at its estimate until it is settled");
    assert.equal(held?.reservedUsd, 0.63);

    const poll = await pollFor(h, job);
    const settled = await h.router.settle(job, poll, input);
    assert.equal(settled.step.status, "done");
    if (settled.step.status !== "done") return;
    assert.equal(settled.step.asset.providerId, KLING_ID);
    assert.equal(settled.step.asset.costUsd, 0.6125, "the asset costs what the provider billed");
    assert.equal(settled.step.asset.submits, 1);
    assert.equal(settled.step.asset.ledgerEntryId, held?.entryId);
    assert.equal(settled.step.asset.uri, "https://openrouter.ai/api/v1/videos/job-kling/content?index=0", "without takes, the provider's own uri");

    const billed = await h.ledger.getEntryByKey(job.idempotencyKey);
    assert.equal(billed?.actualUsd, 0.6125);
    assert.equal(billed?.settlement, "billed");
    assert.equal(await h.buckets.inFlight(KLING_ID), 0, "settling releases the slot");
    assert.equal((await h.cache.get(WORKSPACE, assetCacheKey(spec, KLING_ID)))?.costUsd, 0.6125, "the finished asset is cached");
    assert.deepEqual(
      (await h.stats.since(KLING_ID, 0)).map((record) => record.outcome),
      ["success"],
      "the success is recorded",
    );

    // Settling the same job again changes nothing: no call, no ledger write, no stats record, no second cache write.
    const requestsBefore = h.requests.length;
    const rowsBefore = await rowsOf(h);
    const statsBefore = (await h.stats.since(KLING_ID, 0)).length;
    const again = await h.router.settle(job, poll, input);
    assert.deepEqual(again, settled, "the second settle returns the first result");
    assert.equal(h.requests.length, requestsBefore, "nothing is sent again");
    assert.deepEqual(await rowsOf(h), rowsBefore, "the ledger is unchanged");
    assert.equal((await h.stats.since(KLING_ID, 0)).length, statsBefore, "no second stats record");
  });

  it("a failed job with a bill settles to the next target: the failed submit is settled at its bill, and the next target is submitted", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")], [WAN]: [accepted("job-wan")] }),
        "GET /api/v1/videos/job-wan": completed("job-wan", 0.4),
      },
    });
    const spec = assetSpec();
    const input = h.input(spec);
    const first = await h.router.submit(input);
    assert.equal(first.step.status, "submitted");
    if (first.step.status !== "submitted") return;

    // The provider billed the failed job (0.25, not the 0.63 estimate). A poll with no bill would leave the submit unsettled instead.
    const failed: ProviderPoll = { state: "failed", error: { kind: "unknown", retryable: false, message: "the model stopped" }, actualUsd: 0.25 };
    const next = await h.router.settle(first.step.job, failed, input);
    assert.equal(next.step.status, "submitted");
    if (next.step.status !== "submitted") return;
    const job = next.step.job;
    assert.equal(job.providerId, WAN_ID, "the next target is submitted");
    assert.equal(job.targetIndex, 1);
    assert.equal(job.earlierTargetsBilledUsd, 0.25, "the failed target's bill travels with the next target's job");
    assert.equal(job.submitNumber, 2, "the submit counter runs across targets");
    assert.equal(job.attemptOnTarget, 1, "a new target starts at its first attempt");
    assert.equal(job.carry.exhausted.length, 1, "the failed target is carried for the final reason");
    assert.match(job.carry.exhausted[0] ?? "", /^openrouter:kwaivgi\/kling-v3\.0-std: unknown: the model stopped$/);
    assert.deepEqual(
      next.attempts.map((attempt) => [attempt.providerId, attempt.outcome]),
      [[KLING_ID, "provider_failure"]],
      "the failure is one attempt, recorded",
    );
    const fallback = next.decisions.find((decision) => decision.chose === WAN_ID);
    assert.match(fallback?.reason ?? "", /fell back from openrouter:kwaivgi\/kling-v3\.0-std after/);

    const kling = await h.ledger.getEntryByKey(first.step.job.idempotencyKey);
    assert.equal(kling?.actualUsd, 0.25, "the failed submit is settled at the provider's bill");
    assert.equal(kling?.settlement, "billed");
    assert.equal(await h.buckets.inFlight(KLING_ID), 0, "the failed target gives its slot back");
    assert.equal(await h.buckets.inFlight(WAN_ID), 1, "the next target holds one");

    const done = await h.router.settle(job, await pollFor(h, job), input);
    assert.equal(done.step.status, "done");
    if (done.step.status === "done") {
      assert.equal(done.step.asset.providerId, WAN_ID);
      // The asset costs every bill it made: the failed submit (0.25) and the winning submit (0.4).
      assert.equal(done.step.asset.costUsd, 0.65, "the failed submit's bill is part of the cost, not dropped");
      assert.equal((await h.cache.get(WORKSPACE, assetCacheKey(spec, WAN_ID)))?.costUsd, 0.65, "the cache records the same cost");
    }
    assert.deepEqual(
      (await h.ledger.listEntries(h.reservationId)).map((row) => row.actualUsd),
      [0.25, 0.4],
      "the ledger holds each bill, and their sum is the asset's cost",
    );
  });

  it("a rate-limited job is billed for its first submit, retries on the same target with a new key, and its cost is the sum of its bills", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling"), accepted("job-kling-2")] }),
        "GET /api/v1/videos/job-kling-2": completed("job-kling-2", 0.6125),
      },
    });
    const spec = assetSpec();
    const input = h.input(spec);
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const job1 = first.step.job;

    // The first job was billed 0.63 before the poll reported the rate limit. A poll with no bill would leave it unsettled.
    const limited: ProviderPoll = { state: "failed", error: { kind: "rate_limit", retryable: true, message: "slow down" }, actualUsd: 0.63 };
    const retry = await h.router.settle(job1, limited, input);
    assert.equal(retry.step.status, "submitted");
    if (retry.step.status !== "submitted") return;
    const job2 = retry.step.job;
    assert.equal(job2.providerId, KLING_ID, "the retry stays on the same target");
    assert.equal(job2.targetIndex, 0);
    assert.equal(job2.attemptOnTarget, 2);
    assert.equal(job2.idempotencyKey, `${assetCacheKey(spec, KLING_ID)}|attempt2`, "a retry is its own key on the ledger");
    assert.equal(retry.step.runAfterMs, 1000, "the retry waits the first backoff before its first poll");
    assert.equal(job2.targetSubmits, 2);
    assert.equal(await h.buckets.inFlight(KLING_ID), 1, "the retry keeps the one slot the target holds");
    assert.equal(posts(h.requests, KLING), 2);

    const done = await h.router.settle(job2, await pollFor(h, job2), input);
    assert.equal(done.step.status, "done");
    if (done.step.status !== "done") return;
    assert.equal(done.step.asset.costUsd, 1.2425, "the first refused submit (0.63) and the billed retry (0.6125)");
    assert.equal(done.step.asset.submits, 2);
    assert.equal(done.step.asset.ledgerEntryId, (await h.ledger.getEntryByKey(job1.idempotencyKey))?.entryId, "the asset names its first entry");
  });

  it("a target billed on a rate-limited job whose retries are refused is part of the asset's cost when the next target settles", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-first"), json(429, {}), json(429, {})], [WAN]: [accepted("job-second")] }),
        "GET /api/v1/videos/job-second": completed("job-second", 0.4),
      },
    });
    const spec = assetSpec();
    const input = h.input(spec);
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");

    // The first job was billed 0.63 before its poll reported a rate limit. Both retries are refused before a job exists, so the target is
    // exhausted and the next target is submitted, carrying the 0.63.
    const limited: ProviderPoll = { state: "failed", error: { kind: "rate_limit", retryable: true, message: "slow down" }, actualUsd: 0.63 };
    const next = await h.router.settle(first.step.job, limited, input);
    assert.equal(next.step.status, "submitted");
    if (next.step.status !== "submitted") return;
    assert.equal(next.step.job.providerId, WAN_ID);
    assert.equal(next.step.job.earlierTargetsBilledUsd, 0.63);

    const done = await h.router.settle(next.step.job, await pollFor(h, next.step.job), input);
    assert.equal(done.step.status, "done");
    if (done.step.status !== "done") return;
    assert.equal(done.step.asset.costUsd, 1.03, "the billed first target (0.63) and the billed next target (0.4)");
    assert.deepEqual(
      (await h.ledger.listEntries(h.reservationId)).map((row) => row.actualUsd),
      [0.63, 0, 0, 0.4],
      "the first target's bill, its two refused retries (0 each), and the next target's bill",
    );
  });
});

describe("settling is idempotent and single-flight", () => {
  it("settling a retried job twice does not submit the retry twice", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling"), accepted("job-kling-2")] }),
      },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const limited: ProviderPoll = { state: "failed", error: { kind: "rate_limit", retryable: true, message: "slow down" }, actualUsd: 0.63 };
    const once = await h.router.settle(first.step.job, limited, input);
    const twice = await h.router.settle(first.step.job, limited, input);
    assert.deepEqual(twice, once);
    assert.equal(posts(h.requests, KLING), 2, "one submit, one retry: the second settle sent nothing");
  });

  it("two settles of one job at once: one runs, the other is refused as retryable, and the retry is sent once", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling"), accepted("job-kling-2")] }) },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const limited: ProviderPoll = { state: "failed", error: { kind: "rate_limit", retryable: true, message: "slow down" }, actualUsd: 0.63 };
    const results = await Promise.allSettled([h.router.settle(first.step.job, limited, input), h.router.settle(first.step.job, limited, input)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one settle runs");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof EngineError);
    assert.equal((rejected[0]?.reason as EngineError).kind, "conflict");
    assert.equal((rejected[0]?.reason as EngineError).retryable, true);
    assert.equal(posts(h.requests, KLING), 2, "the retry is sent once");
  });

  it("a timed-out job with no bill is unsettled: it is not retried and the next target does not run", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")], [WAN]: [accepted("job-wan")] }) },
    });
    const spec = assetSpec();
    const input = h.input(spec);
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const timedOut: ProviderPoll = { state: "failed", error: { kind: "timeout", retryable: true, message: "no result within 600000 ms" } };
    const next = await h.router.settle(first.step.job, timedOut, input);
    assert.equal(next.step.status, "unsettled", "a polled job with no bill stays unsettled: the provider may have billed it");
    if (next.step.status === "unsettled") assert.equal(next.step.providerId, KLING_ID);
    assert.equal(posts(h.requests, KLING), 1, "no retry on the timed-out target");
    assert.equal(posts(h.requests, WAN), 0, "no submit to the next target");
    assert.deepEqual(
      next.attempts.map((attempt) => [attempt.providerId, attempt.errorKind]),
      [[KLING_ID, "timeout"]],
    );
    const held = await h.ledger.getEntryByKey(first.step.job.idempotencyKey);
    assert.equal(held?.settlement, undefined);
    assert.equal(held?.actualUsd, undefined, "no estimate is booked as the actual");
    assert.equal(await h.cache.get(WORKSPACE, assetCacheKey(spec, KLING_ID)), null, "nothing is cached");
    assert.equal(await h.buckets.inFlight(KLING_ID), 0);
  });
});

describe("a submit answer with no job id is a failed submit", () => {
  it("an answer with no job id is ambiguous: the submit stays unsettled, and no next target is submitted", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [json(200, { status: "pending" })], [WAN]: [accepted("job-wan")] }),
      },
    });
    const spec = assetSpec();
    const submitted = await h.router.submit(h.input(spec));
    assert.equal(submitted.step.status, "unsettled", "the provider may have billed a job it did not name");
    if (submitted.step.status === "unsettled") assert.equal(submitted.step.providerId, KLING_ID);
    assert.equal(submitted.attempts[0]?.errorKind, "unknown");
    assert.equal(posts(h.requests, WAN), 0, "no submit to the next target");
    assert.equal(await h.buckets.inFlight(KLING_ID), 0, "the target gives its slot back");
    assert.equal(await h.buckets.inFlight(WAN_ID), 0);
    const kling = await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID));
    assert.equal(kling?.actualUsd, undefined, "no estimate is booked as the actual");
    assert.equal(kling?.settlement, undefined);
  });
});

describe("settle refuses what it must not settle", () => {
  it("a planner refusal with its bill settles to failed with no next target, and the submit is settled at that bill", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")], [WAN]: [accepted("job-wan")] }) },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const refused: ProviderPoll = { state: "failed", error: { kind: "content_policy", retryable: false, message: "refused by policy" }, actualUsd: 0.25 };
    const settled = await h.router.settle(first.step.job, refused, input);
    assert.equal(settled.step.status, "failed");
    if (settled.step.status === "failed") assert.equal(settled.step.error.kind, "content_policy");
    assert.equal(posts(h.requests), 1, "no next target is submitted");
    const billed = await h.ledger.getEntryByKey(first.step.job.idempotencyKey);
    assert.equal(billed?.actualUsd, 0.25);
    assert.equal(billed?.settlement, "billed");
  });

  it("a pending answer is refused, and it leaves no claim behind", async () => {
    const h = await harness({
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
      },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    await assert.rejects(
      h.router.settle(first.step.job, { state: "pending" }, input),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    const settled = await h.router.settle(first.step.job, await pollFor(h, first.step.job), input);
    assert.equal(settled.step.status, "done", "the job still settles after the refusal");
  });

  it("a job cannot be settled by another workspace, and nothing is written", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }) },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const rowsBefore = await rowsOf(h);
    await assert.rejects(
      h.router.settle(first.step.job, { state: "failed", error: { kind: "unknown", retryable: false, message: "x" } }, { ...input, workspaceId: "org_2" }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.deepEqual(await rowsOf(h), rowsBefore);
    assert.equal(await h.buckets.inFlight(KLING_ID), 1, "the other workspace does not free this job's slot");
  });

  it("a spec other than the one submitted is refused", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }) },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const other = h.input(assetSpec({ prompt: "A different prompt entirely." }));
    await assert.rejects(
      h.router.settle(first.step.job, { state: "failed", error: { kind: "unknown", retryable: false, message: "x" } }, other),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("the take is downloaded and checked through the gateway when takes are on", () => {
  it("a finished take is downloaded, checked as an mp4, and stored: the asset names the stored copy", async () => {
    const h = await harness({
      takes: true,
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
        [CONTENT("job-kling")]: raw(200, mp4Bytes(), { "content-type": "video/mp4" }),
      },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const settled = await h.router.settle(first.step.job, await pollFor(h, first.step.job), input);
    assert.equal(settled.step.status, "done");
    if (settled.step.status !== "done") return;
    assert.match(settled.step.asset.uri, /^memory:\/\/org_1\//);
    assert.equal(settled.step.asset.mediaType, "video/mp4");
    assert.equal(h.media.objects.size, 1);
    assert.equal([...h.media.objects.values()][0]?.mediaType, "video/mp4");
  });

  it("a download that answers 503 is retried by the job: nothing is reconciled until the take is stored", async () => {
    const h = await harness({
      takes: true,
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
        [CONTENT("job-kling")]: [raw(503, new Uint8Array([1])), raw(200, mp4Bytes())],
      },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const poll = await pollFor(h, first.step.job);
    await assert.rejects(h.router.settle(first.step.job, poll, input), (error: unknown) => error instanceof EngineError && error.kind === "provider");
    assert.equal((await h.ledger.getEntryByKey(first.step.job.idempotencyKey))?.actualUsd, undefined, "no bill is recorded for an unfinished settle");
    assert.equal(await h.buckets.inFlight(KLING_ID), 0, "the slot is freed when the settle is refused");
    const settled = await h.router.settle(first.step.job, poll, input);
    assert.equal(settled.step.status, "done", "the poll job's retry settles it");
  });

  it("a file that is not an mp4 is a failed take: the next target runs", async () => {
    const h = await harness({
      takes: true,
      script: {
        "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-kling")], [WAN]: [accepted("job-wan")] }),
        "GET /api/v1/videos/job-kling": completed("job-kling", 0.6125),
        [CONTENT("job-kling")]: raw(200, new Uint8Array(8192).fill(0x41)),
      },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const next = await h.router.settle(first.step.job, await pollFor(h, first.step.job), input);
    assert.equal(next.step.status, "submitted");
    if (next.step.status === "submitted") assert.equal(next.step.job.providerId, WAN_ID);
    assert.equal(h.media.objects.size, 0, "nothing that failed the checks is stored");
    assert.equal(next.attempts[0]?.errorKind, "unknown", "the failed take is a non-retryable failure of its target");
    assert.equal(next.attempts[0]?.outcome, "provider_failure");
  });
});

describe("the default settings carry the Bible values", () => {
  it("the attempts per target come from thresholds.jobs.maxAttempts", () => {
    assert.equal(defaultRouterSettings().maxAttempts, 3);
  });
});

describe("a measured clip holds the plan's measure hold (D15)", () => {
  it("a retry of a measured clip is held at the measure hold too: the settle carries the input the submit was made with", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-first"), accepted("job-retry")] }) },
    });
    const spec = assetSpec();
    const input = h.input(spec, { measureHoldUsd: 2.5 });
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");
    const limited: ProviderPoll = { state: "failed", error: { kind: "rate_limit", retryable: true, message: "slow down" }, actualUsd: 0.63 };
    const retry = await h.router.settle(first.step.job, limited, input);
    assert.equal(retry.step.status, "submitted");
    const retried = await h.ledger.getEntryByKey(`${assetCacheKey(spec, KLING_ID)}|attempt2`);
    assert.equal(retried?.reservedUsd, 2.5, "the retry is held at the plan's measure hold, not the route's price");
    assert.equal(retried?.estimateUsd, 2.5);
  });

  it("a measure hold that is not a positive amount is refused before any call or ledger row", async () => {
    for (const measureHoldUsd of [0, -1, Number.NaN]) {
      const h = await harness({ script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-first")] }) } });
      const spec = assetSpec();
      await assert.rejects(
        h.router.submit(h.input(spec, { measureHoldUsd })),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      );
      assert.equal(posts(h.requests), 0, "nothing is sent");
      assert.equal(await h.ledger.getEntryByKey(assetCacheKey(spec, KLING_ID)), null, "nothing is authorized");
    }
  });
});

/** The family of a model: its vendor prefix, which is how the policy names a family (config/model-policy.ts). */
const familyOf = (model: string): string => `${model.split("/")[0] ?? model}/`;

/** A router over the same gateway, ledger and stores, built at settle time with the families in force then, as the poller builds one (D16). */
function settlingRouter(h: Harness, disabledFamilies: readonly string[]): AsyncAssetRouter {
  return createAssetRouter({
    gateway: h.gateway,
    ledger: h.ledger,
    cache: h.cache,
    stats: h.stats,
    breakers: h.breakers,
    buckets: h.buckets,
    media: h.media,
    videoProfiles: profiles,
    signals,
    disabledFamilies,
    now: h.clock.now,
    sleep: h.clock.sleep,
  });
}

describe("a family switched off while a job is in flight is not used by a submit made at settle time (D16)", () => {
  it("a fallback skips a target of a family switched off after the submit, and submits the next allowed target", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-first")], [WAN]: [accepted("job-second")], [SEED]: [accepted("job-third")] }) },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");

    // The second target's family is switched off while the first job is in flight: the settle runs with the families in force now.
    const failed: ProviderPoll = { state: "failed", error: { kind: "unknown", retryable: false, message: "the model stopped" }, actualUsd: 0.25 };
    const next = await settlingRouter(h, [familyOf(WAN)]).settle(first.step.job, failed, input);
    assert.equal(next.step.status, "submitted");
    if (next.step.status !== "submitted") return;
    assert.equal(next.step.job.providerId, `openrouter:${SEED}`, "the next allowed target is submitted");
    assert.equal(posts(h.requests, WAN), 0, "the switched-off target is never submitted");
    assert.match(next.step.job.carry.excluded.join("\n"), /switched off by the model policy/, "the skipped target is named in the carry");
  });

  it("a rate-limited submit is not retried on a family switched off after the submit, and the next allowed target is submitted", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-first")], [WAN]: [accepted("job-second")] }) },
    });
    const input = h.input(assetSpec());
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");

    // The first target's family is switched off while its job is in flight: its rate-limited submit gets no retry, and the next target is used.
    const limited: ProviderPoll = { state: "failed", error: { kind: "rate_limit", retryable: true, message: "slow down" }, actualUsd: 0.63 };
    const next = await settlingRouter(h, [familyOf(KLING)]).settle(first.step.job, limited, input);
    assert.equal(next.step.status, "submitted");
    if (next.step.status !== "submitted") return;
    assert.equal(next.step.job.providerId, WAN_ID, "the next allowed target is submitted");
    assert.equal(posts(h.requests, KLING), 1, "no retry is sent to the switched-off target");
    assert.match(next.step.job.carry.excluded.join("\n"), /not retried/, "the skipped retry is named in the carry");
  });

  it("a job in flight whose family was switched off is still settled: its poll is not refused, and its bill is recorded", async () => {
    const h = await harness({
      script: { "POST /api/v1/videos": submitFor({ [KLING]: [accepted("job-first")] }), "GET /api/v1/videos/job-first": completed("job-first", 0.6125) },
    });
    const spec = assetSpec();
    const input = h.input(spec);
    const first = await h.router.submit(input);
    if (first.step.status !== "submitted") assert.fail("the first submit should be sent");

    const done = await settlingRouter(h, [familyOf(KLING)]).settle(first.step.job, await pollFor(h, first.step.job), input);
    assert.equal(done.step.status, "done", "a job already in flight is not refused");
    if (done.step.status === "done") assert.equal(done.step.asset.costUsd, 0.6125, "its bill is recorded");
  });
});
