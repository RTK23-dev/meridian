import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateBreaker, memoryBreakerStore, openBreaker, type BreakerSettings } from "./breaker.ts";
import { memoryProviderStats, medianLatencyMs, successRate, type AttemptRecord } from "./stats.ts";
import { memoryBucketStore, bucketClassFor } from "./buckets.ts";

const SETTINGS: BreakerSettings = { failureShare: 0.3, windowMs: 600_000, skipMs: 600_000, minSample: 1 };
const T0 = 1_000_000;
const ID = "openrouter:kwaivgi/kling-v3.0-std";

function record(atMs: number, outcome: AttemptRecord["outcome"], latencyMs: number | null = null): AttemptRecord {
  return { providerId: ID, atMs, outcome, latencyMs, errorKind: outcome === "success" ? null : "server" };
}

describe("circuit breaker", () => {
  it("trips when provider failures are over 30% of the window, and skips for 10 minutes", async () => {
    const stats = memoryProviderStats();
    const breakers = memoryBreakerStore();
    await stats.record(record(T0, "success"));
    assert.equal(await evaluateBreaker(stats, breakers, ID, T0, SETTINGS), null);
    await stats.record(record(T0 + 1000, "provider_failure"));
    const tripped = await evaluateBreaker(stats, breakers, ID, T0 + 1000, SETTINGS);
    assert.deepEqual(tripped, { trippedAtMs: T0 + 1000, openUntilMs: T0 + 1000 + 600_000 });
    assert.ok(await openBreaker(breakers, ID, T0 + 300_000));
    assert.equal(await openBreaker(breakers, ID, T0 + 1000 + 600_000), null);
  });

  it("does not trip below the minimum sample, however bad the share", async () => {
    const stats = memoryProviderStats();
    const breakers = memoryBreakerStore();
    const settings = { ...SETTINGS, minSample: 5 };
    for (let i = 0; i < 4; i += 1) await stats.record(record(T0 + i, "provider_failure"));
    assert.equal(await evaluateBreaker(stats, breakers, ID, T0 + 4, settings), null, "4 failures of 4 is under the 5-attempt minimum");
    await stats.record(record(T0 + 5, "provider_failure"));
    assert.ok(await evaluateBreaker(stats, breakers, ID, T0 + 5, settings), "the fifth failure trips it");
  });

  it("does not trip at exactly the limit, and does not count refused requests", async () => {
    const stats = memoryProviderStats();
    const breakers = memoryBreakerStore();
    for (let i = 0; i < 7; i += 1) await stats.record(record(T0 + i, "success"));
    for (let i = 0; i < 3; i += 1) await stats.record(record(T0 + 10 + i, "provider_failure"));
    assert.equal(await evaluateBreaker(stats, breakers, ID, T0 + 20, SETTINGS), null, "3 of 10 is 30%, not over it");
    for (let i = 0; i < 20; i += 1) await stats.record({ ...record(T0 + 30 + i, "request_refused"), errorKind: "content_policy" });
    assert.equal(await evaluateBreaker(stats, breakers, ID, T0 + 60, SETTINGS), null);
  });

  it("ignores failures older than the window", async () => {
    const stats = memoryProviderStats();
    const breakers = memoryBreakerStore();
    await stats.record(record(T0, "provider_failure"));
    await stats.record(record(T0 + 700_000, "success"));
    assert.equal(await evaluateBreaker(stats, breakers, ID, T0 + 700_000, SETTINGS), null);
  });

  it("recovers after the skip and is not tripped again by the failures that tripped it", async () => {
    const stats = memoryProviderStats();
    const breakers = memoryBreakerStore();
    await stats.record(record(T0, "provider_failure"));
    assert.ok(await evaluateBreaker(stats, breakers, ID, T0, SETTINGS));
    const recovered = T0 + 600_000;
    assert.equal(await openBreaker(breakers, ID, recovered), null, "closed again after the skip");
    await stats.record(record(recovered + 1, "success"));
    assert.equal(await evaluateBreaker(stats, breakers, ID, recovered + 1, SETTINGS), null);
  });

  it("does not re-trip on in-flight failures that landed during the skip", async () => {
    const stats = memoryProviderStats();
    const breakers = memoryBreakerStore();
    await stats.record(record(T0, "provider_failure"));
    assert.ok(await evaluateBreaker(stats, breakers, ID, T0, SETTINGS));
    await stats.record(record(T0 + 1000, "provider_failure"));
    await stats.record(record(T0 + 3000, "provider_failure"));
    const recovered = T0 + 600_000;
    await stats.record(record(recovered + 1, "success"));
    assert.equal(await evaluateBreaker(stats, breakers, ID, recovered + 1, SETTINGS), null);
  });
});

describe("provider statistics", () => {
  it("success rate counts provider-side attempts only, and is unknown with none", () => {
    assert.equal(successRate([]), null);
    assert.equal(successRate([record(1, "success"), record(2, "provider_failure"), record(3, "request_refused")]), 0.5);
  });

  it("median latency is over successes with a latency, and unknown without one", () => {
    assert.equal(medianLatencyMs([record(1, "success", 100), record(2, "success", 300), record(3, "success", 200)]), 200);
    assert.equal(medianLatencyMs([record(1, "success", 100), record(2, "success", 300)]), 200);
    assert.equal(medianLatencyMs([record(1, "provider_failure", 50)]), null);
  });
});

describe("concurrency buckets", () => {
  it("takes at most the limit and frees a slot on release", async () => {
    const buckets = memoryBucketStore();
    assert.equal(await buckets.tryAcquire(ID, 2), true);
    assert.equal(await buckets.tryAcquire(ID, 2), true);
    assert.equal(await buckets.tryAcquire(ID, 2), false);
    await buckets.release(ID);
    assert.equal(await buckets.tryAcquire(ID, 2), true);
    assert.equal(await buckets.inFlight(ID), 2);
  });

  it("maps model classes to the video, image and tts limits", () => {
    assert.equal(bucketClassFor("video.cinematic"), "video");
    assert.equal(bucketClassFor("avatar"), "video");
    assert.equal(bucketClassFor("image.keyframe"), "image");
    assert.equal(bucketClassFor("tts"), "tts");
  });
});
