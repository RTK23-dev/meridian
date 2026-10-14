import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { newId } from "../contracts/ids.ts";
import { ASSET_JOB_SCHEMA, CARRY_LIMIT, memorySettlementStore, parseAssetJob, type AssetJob } from "./job.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const KLING_ID = `openrouter:${KLING}`;
const CACHE_KEY = `sha256:${"a".repeat(64)}`;

/** A job as submit builds it. Each test changes one field, so a failure names that field. */
function validJob(overrides: Partial<AssetJob> = {}): AssetJob {
  return {
    schema: ASSET_JOB_SCHEMA,
    jobRef: "job-kling",
    workspaceId: "org_1",
    requestId: newId("req_"),
    reservationId: newId("res_"),
    stage: "produce_shot",
    modelClass: "video.cinematic",
    providerId: KLING_ID,
    provider: "openrouter",
    model: KLING,
    idempotencyKey: CACHE_KEY,
    attemptOnTarget: 1,
    submitNumber: 1,
    submittedAt: "2026-10-14T10:00:00.000Z",
    targets: [{ adapterId: KLING_ID, provider: "openrouter", model: KLING, cacheKey: CACHE_KEY, estimateUsd: 0.63 }],
    targetIndex: 0,
    targetBilledUsd: 0,
    targetAllBilled: true,
    targetSubmits: 1,
    targetFirstEntryId: null,
    carry: { excluded: [], exhausted: [], refused: [], queued: [], duplicate: null },
    ...overrides,
  };
}

function refusedWith(job: unknown): string {
  try {
    parseAssetJob(job);
  } catch (error) {
    assert.ok(error instanceof EngineError, "a refused job is a typed engine error");
    assert.equal(error.kind, "invalid_input");
    return error.message;
  }
  assert.fail("the job should have been refused");
}

describe("asset job references", () => {
  it("parses a job as submit builds it", () => {
    const job = validJob();
    assert.deepEqual(parseAssetJob(job), job);
  });

  it("refuses another schema version", () => {
    assert.match(refusedWith({ ...validJob(), schema: "meridian.asset_job/v0" }), /does not parse/);
  });

  it("refuses a providerId that is not the adapter id of the target at targetIndex", () => {
    assert.match(refusedWith(validJob({ providerId: "openrouter:other/model" })), /providerId/);
  });

  it("refuses a target index with no target", () => {
    assert.match(refusedWith(validJob({ targetIndex: 1 })), /providerId/);
  });

  it("refuses a reservation that is not a res_ id", () => {
    assert.match(refusedWith(validJob({ reservationId: newId("req_") })), /does not parse/);
  });

  it("refuses money with more than four decimals", () => {
    const job = validJob();
    job.targets[0] = { ...job.targets[0]!, estimateUsd: 0.12345 };
    assert.match(refusedWith(job), /does not parse/);
  });

  it("refuses a submit time that is not an ISO time", () => {
    assert.match(refusedWith(validJob({ submittedAt: "yesterday" })), /does not parse/);
  });

  it("refuses a carry longer than the limit: a job stays small", () => {
    const exhausted = Array.from({ length: CARRY_LIMIT + 1 }, (_, index) => `target ${index} failed`);
    assert.match(refusedWith(validJob({ carry: { excluded: [], exhausted, refused: [], queued: [], duplicate: null } })), /does not parse/);
  });

  it("refuses a model class the contract does not know", () => {
    assert.match(refusedWith({ ...validJob(), modelClass: "video.unknown" }), /does not parse/);
  });
});

describe("the settlement store", () => {
  it("a claim is granted once; a second claim by another call is told the first is still running", async () => {
    const store = memorySettlementStore<string>();
    const lease = { nowMs: 1000, leaseMs: 60_000 };
    assert.deepEqual(await store.claim("job", { owner: "a", ...lease }), { status: "claimed" });
    assert.deepEqual(await store.claim("job", { owner: "b", ...lease }), { status: "in_progress" });
  });

  it("a completed result is returned to every later claim, as a copy", async () => {
    const store = memorySettlementStore<{ costUsd: number }>();
    await store.claim("job", { owner: "a", nowMs: 0, leaseMs: 1000 });
    await store.complete("job", "a", { costUsd: 0.5 });
    const first = await store.claim("job", { owner: "b", nowMs: 1, leaseMs: 1000 });
    assert.equal(first.status, "settled");
    if (first.status === "settled") first.value.costUsd = 99;
    const again = await store.claim("job", { owner: "c", nowMs: 2, leaseMs: 1000 });
    assert.deepEqual(again, { status: "settled", value: { costUsd: 0.5 } }, "a copy is returned, so the store is not changed by a caller");
  });

  it("the first completed result wins", async () => {
    const store = memorySettlementStore<string>();
    await store.claim("job", { owner: "a", nowMs: 0, leaseMs: 1000 });
    await store.complete("job", "a", "first");
    await store.complete("job", "a", "second");
    assert.deepEqual(await store.claim("job", { owner: "b", nowMs: 1, leaseMs: 1000 }), { status: "settled", value: "first" });
  });

  it("only the owner releases a claim, and a released claim can be taken again", async () => {
    const store = memorySettlementStore<string>();
    await store.claim("job", { owner: "a", nowMs: 0, leaseMs: 1000 });
    await store.release("job", "b");
    assert.deepEqual(await store.claim("job", { owner: "b", nowMs: 1, leaseMs: 1000 }), { status: "in_progress" }, "a stranger cannot release it");
    await store.release("job", "a");
    assert.deepEqual(await store.claim("job", { owner: "b", nowMs: 2, leaseMs: 1000 }), { status: "claimed" });
  });

  it("an expired claim is taken over, so a worker that died mid-settle does not block the job for ever", async () => {
    const store = memorySettlementStore<string>();
    await store.claim("job", { owner: "dead", nowMs: 0, leaseMs: 1000 });
    assert.deepEqual(await store.claim("job", { owner: "live", nowMs: 1001, leaseMs: 1000 }), { status: "claimed" });
  });
});
