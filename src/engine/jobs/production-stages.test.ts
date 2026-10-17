// The production ports of the analyze_reference, write_script and voice stages (production-stages.ts), and their registration in the
// production runtime. The reference is read from the store under its request's brand and released when the analysis ends; a brief's
// reference stops before any call (no speech language); and the voice port refuses before the speech route is called, with the blockers
// named. No test calls a provider: the gateway answers from an empty recorded queue, and the test asserts that nothing was requested.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { referenceSpeechLanguageOf, type ReferenceSource } from "../analyze/reference.ts";
import { productionRequestBriefFixture, productionRequestFixture } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { gatewayWith, recordedTransport } from "./test/harness.ts";
import { productionComposition, productionEngineRuntime, type EngineComposition } from "./runtime.ts";
import { productionReferenceSource, productionVoicePortsFor, storeKeyOfReference } from "./production-stages.ts";
import { notConnectedReason } from "../media/stt-connection.ts";
import { EngineError } from "../contracts/index.ts";
import type { AssetRouter } from "../assets/router.ts";

const ORG = "ws_production_stages";
const BRAND = "brand_production_stages";
const REQ = productionRequestFixture.requestId;
const BRIEF_REQ = productionRequestBriefFixture.requestId;

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  for (const id of [REQ, BRIEF_REQ]) {
    await db.sql`
      insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
      values (${id}, ${ORG}, ${BRAND}, 'fmt_fixture_rank', 'normal', 'running', '{}')
    `;
  }
});

after(async () => {
  await db.close();
});

/** A store that records each call and holds one object under the key. */
function recordingStore(objectKey: string) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      async get(organizationId: string, brandId: string, key: string) {
        calls.push(`get ${organizationId} ${brandId} ${key}`);
        return key === objectKey ? { bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" } : null;
      },
      async release(organizationId: string, brandId: string, key: string) {
        calls.push(`release ${organizationId} ${brandId} ${key}`);
      },
    },
  };
}

test("the store:// reference is read as bytes under its request's brand, and released by the same key", async () => {
  const { store, calls } = recordingStore("uploads/reel-1.mp4");
  const source: ReferenceSource = productionReferenceSource({ sql: db.sql, store });
  const resolved = await source.resolve("store://uploads/reel-1.mp4", ORG, REQ);
  assert.equal(resolved.status, "ready");
  if (resolved.status === "ready") {
    assert.equal(resolved.source.kind, "bytes", "the media functions read bytes (in-process ffmpeg refuses URLs)");
  }
  await source.release("store://uploads/reel-1.mp4", ORG, REQ);
  assert.deepEqual(calls, [`get ${ORG} ${BRAND} uploads/reel-1.mp4`, `release ${ORG} ${BRAND} uploads/reel-1.mp4`]);
});

test("a Content Factory reference is not deleted, because the session still names that file", async () => {
  const key = "content-factory/sess-1/reel.mp4";
  const { store, calls } = recordingStore(key);
  const source = productionReferenceSource({ sql: db.sql, store });
  const resolved = await source.resolve(`store://${key}`, ORG, REQ);
  assert.equal(resolved.status, "ready");
  await source.release(`store://${key}`, ORG, REQ);
  assert.deepEqual(calls, [`get ${ORG} ${BRAND} ${key}`], "analysis can read the file, and does not release it");
});

test("a reference that is not in the store is refused as invalid input, never guessed as absent", async () => {
  const { store } = recordingStore("uploads/other.mp4");
  const source = productionReferenceSource({ sql: db.sql, store });
  await assert.rejects(source.resolve("store://uploads/missing.mp4", ORG, REQ), (error: unknown) => {
    return error instanceof EngineError && error.kind === "invalid_input";
  });
});

test("an ig: or s3: reference is not connected: nothing is read, and the reason says so", async () => {
  const { store, calls } = recordingStore("x");
  const source = productionReferenceSource({ sql: db.sql, store });
  const resolved = await source.resolve("ig:reel/FIXTURE0001", ORG, REQ);
  assert.equal(resolved.status, "not_connected");
  assert.match(resolved.status === "not_connected" ? resolved.reason : "", /only a store:\/\/ reference is read/);
  assert.deepEqual(calls, []);
  assert.equal(storeKeyOfReference("s3://bucket/key.mp4"), null);
});

test("a brief's reference is transcribed with the vendor's language detection (no language is named); a script's is its own language", () => {
  assert.equal(referenceSpeechLanguageOf(productionRequestBriefFixture), null, "a brief names no language: the vendor detects it");
  assert.equal(referenceSpeechLanguageOf(productionRequestFixture), productionRequestFixture.script?.language, "a script names its language");
});

test("the voice port sends the speech through the job's asset router, and returns the router's report as it is", async () => {
  const { store } = recordingStore("x");
  const calls: unknown[] = [];
  const report = { outcome: { status: "unavailable" as const, reasons: ["the test router answered"] }, decisions: [], alerts: [], attempts: [] };
  const router = { produce: async (input: unknown) => (calls.push(input), report) } as unknown as AssetRouter;
  const voice = productionVoicePortsFor({
    sql: db.sql,
    objects: store as never,
    media: {} as never,
    speech: { connection: { status: "not_connected", reason: notConnectedReason("test") }, sttPricePerMinuteUsd: null },
    roles: () => ({}) as never,
    router: () => router,
  });
  const ports = voice({ organizationId: ORG, requestId: REQ, reservationId: "res_production_stages" });
  assert.equal(await ports.router.produce({ spec: "the spec" } as never), report);
  assert.equal(calls.length, 1, "the router is called once");
});

test("with no asset router built for the job, the speech is not sent: NOT_CONNECTED with its reason", async () => {
  const { store } = recordingStore("x");
  const { requests } = recordedTransport({});
  const voice = productionVoicePortsFor({
    sql: db.sql,
    objects: store as never,
    media: {} as never,
    speech: { connection: { status: "not_connected", reason: notConnectedReason("test") }, sttPricePerMinuteUsd: null },
    roles: () => ({}) as never,
    router: () => null,
  });
  const ports = voice({ organizationId: ORG, requestId: REQ, reservationId: "res_production_stages" });
  const report = await ports.router.produce({} as never);
  assert.equal(report.outcome.status, "not_connected");
  assert.match(report.outcome.status === "not_connected" ? report.outcome.reasons.join(" ") : "", /asset router is not built/);
  assert.equal(requests.length, 0, "no speech call is sent");
});

test("production registers analyze_reference, write_script and voice with their ports; the composition gives each its deps", () => {
  const composition: EngineComposition = productionComposition(db.sql, {
    gateway: gatewayWith(recordedTransport({}).transport),
    mediaLinks: { sign: async () => ({ status: "not_connected", reason: "test" }) },
    objects: recordingStore("x").store as never,
  });
  assert.equal(typeof composition.analysis, "function", "analysis is given per job's reservation");
  assert.equal(typeof composition.voice, "function", "voice is given per job's reservation");
  assert.ok(composition.writeScript, "write_script has its ports");
  assert.ok(composition.media, "the media functions are on the composition");
  assert.ok(composition.picture, "the picture client is on the composition");
});

test("the production runtime registers the three stages (analyze_reference, write_script, voice)", () => {
  const runtime = productionEngineRuntime(db.sql);
  assert.ok(runtime.handlers.analyze_reference, "analyze_reference is registered in production");
  assert.ok(runtime.handlers.write_script, "write_script is registered in production");
  assert.ok(runtime.handlers.voice, "voice is registered in production");
});
