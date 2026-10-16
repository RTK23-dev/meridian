// The chain call records (chain-store.ts, Bible 5.1 and 7.1) on PostgreSQL: the spec is written once and the first writer's spec stands,
// an output is written once, a different output for the same call is refused, a record is read only in its own workspace, and a row that
// no longer matches its contract is an internal error.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { assetSpecFixture, fixtureId } from "../contracts/fixtures/index.ts";
import { EngineError, type AssetSpec } from "../contracts/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { readChainCall, recordChainOutput, recordChainSpec, type ChainCallKey, type ChainOutput } from "./chain-store.ts";

const ORG = "org_chain_store";
const BRAND = "brand_chain_store";
const OTHER_ORG = "org_chain_store_other";
const OTHER_BRAND = "brand_chain_store_other";
const REQUEST = fixtureId("req_", 950);
const OTHER_REQUEST = fixtureId("req_", 951);
const SHOT = fixtureId("shot_", 950);
const AT = "2026-10-14T10:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await seedWorkspace(db.sql, OTHER_ORG, OTHER_BRAND);
  // A chain call belongs to a request of its own workspace (migration 0096), so the request exists before any call is written.
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQUEST}, ${ORG}, ${BRAND}, 'fmt_fixture_rank', 'normal', 'running', '{}'),
           (${OTHER_REQUEST}, ${OTHER_ORG}, ${OTHER_BRAND}, 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

function keyOf(output: string, organizationId = ORG, attempt = 1): ChainCallKey {
  return { organizationId, requestId: REQUEST, shotId: SHOT, attempt, output };
}

function specWith(prompt: string): AssetSpec {
  return { ...assetSpecFixture, shotId: SHOT, prompt };
}

function keyframeOutput(uri = "store://keyframes/kf-1.png"): ChainOutput {
  return {
    output: "keyframe",
    modelClass: "image.keyframe",
    uri,
    mediaType: "image/png",
    providerId: "openrouter:fixture/keyframe-image",
    promptHash: "sha256:" + "a".repeat(64),
    costUsd: 0.018,
    costIsEstimate: false,
    cacheHit: false,
    ledgerEntryId: "led_keyframe",
  };
}

describe("chain call records (Bible 5.1)", () => {
  test("a call's spec is written once: the first writer's spec is the one that stands, and a second writer gets it back", async () => {
    const first = await recordChainSpec(db.sql, { ...keyOf("keyframe"), callIndex: 0, spec: specWith("first prompt"), at: AT });
    assert.equal(first.prompt, "first prompt");
    const second = await recordChainSpec(db.sql, { ...keyOf("keyframe"), callIndex: 0, spec: specWith("second prompt"), at: AT });
    assert.equal(second.prompt, "first prompt", "the stored spec stands, so a retry makes the call the first run named");
    const read = await readChainCall(db.sql, keyOf("keyframe"));
    assert.equal(read?.spec.prompt, "first prompt");
    assert.equal(read?.output, null, "a call with a spec and no output has not been made yet");
    assert.equal(read?.callIndex, 0);
  });

  test("an output is written once: the same output again changes nothing, and a different one is refused", async () => {
    await recordChainSpec(db.sql, { ...keyOf("keyframe", ORG, 2), callIndex: 0, spec: specWith("p"), at: AT });
    await recordChainOutput(db.sql, { ...keyOf("keyframe", ORG, 2), made: keyframeOutput(), at: AT });
    await recordChainOutput(db.sql, { ...keyOf("keyframe", ORG, 2), made: keyframeOutput(), at: AT });
    const read = await readChainCall(db.sql, keyOf("keyframe", ORG, 2));
    assert.deepEqual(read?.output, keyframeOutput());

    await assert.rejects(
      recordChainOutput(db.sql, { ...keyOf("keyframe", ORG, 2), made: keyframeOutput("store://keyframes/other.png"), at: AT }),
      (error: unknown) => error instanceof EngineError && error.kind === "conflict",
    );
    assert.deepEqual((await readChainCall(db.sql, keyOf("keyframe", ORG, 2)))?.output, keyframeOutput(), "the first output is kept");
  });

  test("an output with no recorded call is refused: nothing is made to hold it", async () => {
    await assert.rejects(
      recordChainOutput(db.sql, { ...keyOf("clip", ORG, 9), made: { ...keyframeOutput(), output: "clip" }, at: AT }),
      (error: unknown) => error instanceof EngineError && error.kind === "internal",
    );
  });

  test("a record is read only in its own workspace: another workspace sees none of it", async () => {
    await recordChainSpec(db.sql, { ...keyOf("keyframe", ORG, 3), callIndex: 0, spec: specWith("mine"), at: AT });
    assert.equal(await readChainCall(db.sql, keyOf("keyframe", OTHER_ORG, 3)), null);
    const other = await recordChainSpec(db.sql, {
      ...keyOf("keyframe", OTHER_ORG, 3),
      requestId: OTHER_REQUEST,
      callIndex: 0,
      spec: specWith("theirs"),
      at: AT,
    });
    assert.equal(other.prompt, "theirs", "the other workspace writes its own record, not the first one's");
    assert.equal((await readChainCall(db.sql, keyOf("keyframe", ORG, 3)))?.spec.prompt, "mine");
  });

  test("a chain call cannot point at another workspace's request (migration 0096)", async () => {
    await assert.rejects(
      recordChainSpec(db.sql, { ...keyOf("keyframe", OTHER_ORG, 5), callIndex: 0, spec: specWith("x"), at: AT }),
      /engine_chain_calls_request_fk/,
    );
  });

  test("a stored row that no longer matches its contract is an internal error, never returned as data", async () => {
    await recordChainSpec(db.sql, { ...keyOf("keyframe", ORG, 4), callIndex: 0, spec: specWith("p"), at: AT });
    await db.sql`
      update engine_chain_calls set spec = ${'{"schema":"meridian.asset_spec/v1"}'}
      where organization_id = ${ORG} and request_id = ${REQUEST} and shot_id = ${SHOT} and attempt = 4 and output_name = 'keyframe'
    `;
    await assert.rejects(readChainCall(db.sql, keyOf("keyframe", ORG, 4)), (error: unknown) => error instanceof EngineError && error.kind === "internal");
  });
});
