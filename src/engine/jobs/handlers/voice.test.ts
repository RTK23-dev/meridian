// The voice stage handler against PostgreSQL (PGlite): the connections are checked before anything is read or spent. The speech
// pipeline itself is tested on recorded answers in voice/voice.test.ts; here the handler's refusals and its output are checked.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError } from "../../contracts/index.ts";
import { productionRequestFixture, voiceKitFixture } from "../../contracts/fixtures/index.ts";
import {
  deps,
  gatewayFor,
  ledgerWith,
  NOW,
  REQUEST_ID,
  RESERVATION_ID,
  WORKSPACE,
} from "../../claude/test/helpers.ts";
import { memoryMediaStore } from "../../assets/adapter.ts";
import { createAssetRouter, type AssetRouter } from "../../assets/router.ts";
import { memoryAssetCache } from "../../assets/cache.ts";
import { memoryProviderStats } from "../../assets/stats.ts";
import { memoryBreakerStore } from "../../assets/breaker.ts";
import { memoryBucketStore } from "../../assets/buckets.ts";
import type { MediaFunctions } from "../../media/index.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext } from "../types.ts";
import { createVoiceHandler, type VoiceStagePorts } from "./voice.ts";

let db: TestDatabase;
let requestArtifactId: string;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WORKSPACE, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQUEST_ID}, ${WORKSPACE}, 'brand_fixture', 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
  const stored = await writeArtifact(db.sql, {
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    stage: "intake",
    type: "production_request",
    body: productionRequestFixture,
    createdAt: NOW,
  });
  requestArtifactId = stored.artifactId;
});

after(async () => {
  await db.close();
});

/** Ports that must not be used: the refusals below stop the stage before any of them is called. */
async function unusedPorts(): Promise<VoiceStagePorts> {
  const ledger = await ledgerWith(1);
  const media: MediaFunctions = {
    id: "unused",
    probe: async () => {
      throw new Error("not expected");
    },
    frames: async () => {
      throw new Error("not expected");
    },
    loudness: async () => {
      throw new Error("not expected");
    },
    cuts: async () => {
      throw new Error("not expected");
    },
    timeline: async () => {
      throw new Error("not expected");
    },
  };
  const router: AssetRouter = createAssetRouter({
    gateway: gatewayFor([]).gateway,
    ledger,
    cache: memoryAssetCache(),
    stats: memoryProviderStats(),
    breakers: memoryBreakerStore(),
    buckets: memoryBucketStore(),
    media: memoryMediaStore(),
    now: () => Date.parse(NOW),
    sleep: async () => {},
  });
  return {
    router,
    speech: { status: "not_connected", reason: "NOT_CONNECTED: no speech-to-text vendor (test)" },
    sttPricePerMinuteUsd: null,
    media,
    roles: deps(gatewayFor([]).gateway, ledger),
    loadAudio: async () => {
      throw new Error("not expected");
    },
  };
}

function contextFor(reservationId: string | null = RESERVATION_ID): StageContext {
  const payload: EnginePayload = {
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    stage: "voice",
    subjectId: REQUEST_ID,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds: [requestArtifactId],
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_voice_test",
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    stage: "voice",
    subjectId: REQUEST_ID,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function voiceTrackCount(): Promise<number> {
  const rows = await db.sql<{
    n: number;
  }>`select count(*)::int as n from engine_artifacts where request_id = ${REQUEST_ID} and type = 'voice_track'`;
  return rows[0]?.n ?? 0;
}

test("the voice kit store is not wired: the stage throws NOT_CONNECTED before it reads the speech route", async () => {
  const handler = createVoiceHandler(await unusedPorts());
  const before = await voiceTrackCount();
  await assert.rejects(
    () => handler.run(contextFor()),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "config" &&
      /^NOT_CONNECTED:.*voice kit/.test(error.message),
  );
  assert.equal(await voiceTrackCount(), before);
});

test("a voice kit that is not in the workspace stops the stage, and nothing is written", async () => {
  const handler = createVoiceHandler({ ...(await unusedPorts()), voiceKit: async () => null });
  await assert.rejects(
    () => handler.run(contextFor()),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "config" &&
      /not found in this workspace/.test(error.message),
  );
  assert.equal(await voiceTrackCount(), 0);
});

test("the voice stage is a paid stage: without a budget reservation it is refused as a conflict", async () => {
  const handler = createVoiceHandler({
    ...(await unusedPorts()),
    voiceKit: async () => voiceKitFixture,
  });
  await assert.rejects(
    () => handler.run(contextFor(null)),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
  );
});

test("the stage reads its request artifact as its only input", async () => {
  const stored = await readArtifact(db.sql, {
    organizationId: WORKSPACE,
    artifactId: requestArtifactId,
  });
  assert.equal(stored.envelope.type, "production_request");
});
