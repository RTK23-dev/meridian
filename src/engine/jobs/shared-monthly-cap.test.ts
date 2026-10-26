// One monthly cap for video and text. A text hold and a video reservation in the same workspace month each count the other's money, and
// both take the workspace row lock, so neither can pass a cap that only one of them fits. The embedded database always runs; PostgreSQL
// runs too when MERIDIAN_PG_TEST_URL names one, and there the concurrent cases race for real.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { reserve, type ReserveInput } from "../budget/reserve.ts";
import { FIXTURE_IDS, fixtureId, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { startEngineRequest } from "./orchestrator-sql.ts";
import { sqlLedgerStore, withWorkspaceLedger } from "./sql-ledger-store.ts";
import { monthlyHeldUsd, reserveGenerationCall, settleGenerationCall, type HoldInput } from "../../lib/meridian/providers/generation-ledger.ts";

const ORG = "org_shared_cap";
const BRAND = "brand_shared_cap";
const CAP = 1;
/** The scene plan fixture's reservation, with its redo allowance: $0.9595. */
const VIDEO_RESERVED = 0.9595;

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await db.sql`update organizations set monthly_video_budget_usd = ${CAP} where id = ${ORG}`;
  await startEngineRequest(db.sql, {
    organizationId: ORG,
    brandId: BRAND,
    requestId: FIXTURE_IDS.request,
    formatId: "fmt_shared_cap",
    priority: "normal",
    cachedDna: true,
    variantCount: 0,
    requestArtifactId: fixtureId("art_", 601),
  });
});

after(async () => {
  await db.close();
});

let reservationSeq = 100;

/** A reservation id the engine accepts: a res_ prefix with a valid ULID. */
function nextReservationId(): string {
  reservationSeq += 1;
  return fixtureId("res_", reservationSeq);
}

function videoInput(reservationId: string): ReserveInput {
  return {
    requestId: FIXTURE_IDS.request,
    workspaceId: ORG,
    mode: "cap",
    plan: scenePlanFixture,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: CAP,
    now: new Date().toISOString(),
    reservationId,
  };
}

/** A video reservation, as the engine makes it: the same ledger call the production path makes. */
function reserveVideo() {
  const reservationId = nextReservationId();
  return withWorkspaceLedger(db.sql, ORG, (store) => reserve(store, videoInput(reservationId)));
}

function textHold(usd: number, label: string): Promise<{ status: "held"; id: string } | { status: "refused"; reason: string }> {
  const input: HoldInput = {
    organizationId: ORG,
    brandId: BRAND,
    correlationId: `corr-${label}`,
    operation: `shared-cap-${label}`,
    promptId: "p",
    promptVersion: "1",
    inputRef: label,
    provider: "openrouter",
    model: "vendor/writer",
    modelSource: "workspace",
  };
  return reserveGenerationCall(db.sql, input, usd);
}

test("a text hold counts against the month, so a video reservation that would pass the cap alone is paused", async () => {
  await db.sql`delete from model_runs where organization_id = ${ORG}`;
  await db.sql`delete from engine_reservations where organization_id = ${ORG}`;
  const held = await textHold(0.05, "first");
  assert.equal(held.status, "held");

  const video = await reserveVideo();
  assert.equal(video.reservation.state, "paused", "0.05 of text plus 0.9595 of video is over the $1 cap");
  assert.ok(video.alerts.some((alert) => alert.scope === "workspace_month"), "the alert names the workspace month");
});

test("a video reservation counts against the month, so a text hold that would pass the cap alone is refused, and the exact fit is held", async () => {
  await db.sql`delete from model_runs where organization_id = ${ORG}`;
  await db.sql`delete from engine_reservations where organization_id = ${ORG}`;
  const video = await reserveVideo();
  assert.equal(video.reservation.state, "reserved");
  assert.equal(video.reservation.reservedUsd, VIDEO_RESERVED);

  const over = await textHold(0.0406, "over");
  assert.equal(over.status, "refused", "0.9595 plus 0.0406 is $1.0001, one tenth of a cent over the cap");
  if (over.status === "refused") assert.match(over.reason, /monthly budget/);

  const fits = await textHold(0.0405, "fits");
  assert.equal(fits.status, "held", "0.9595 plus 0.0405 is exactly the cap");
  assert.ok(Math.abs((await monthlyHeldUsd(db.sql, ORG)) - CAP) < 1e-9, "the month holds exactly the cap across both");
});

test("the video engine's month total includes the text ledger's held spend, so both sides read the same money", async () => {
  await db.sql`delete from model_runs where organization_id = ${ORG}`;
  await db.sql`delete from engine_reservations where organization_id = ${ORG}`;
  const held = await textHold(0.03, "engine-view");
  assert.equal(held.status, "held");
  if (held.status !== "held") return;
  await settleGenerationCall(db.sql, held.id, {
    status: "completed",
    output: "",
    latencyMs: 1,
    tokens: 10,
    returnedModel: "vendor/writer",
    generationId: "gen-engine-view",
    costUsd: 0.02,
    error: "",
  });
  const month = new Date().toISOString().slice(0, 7);
  const totals = await sqlLedgerStore(db.sql, ORG).sumForMonth(ORG, month);
  assert.equal(totals.reservedUsd, 0.02, "the engine counts the text ledger at its reported cost");
});

test("a released hold stops counting for the video engine as well as for text", async () => {
  await db.sql`delete from model_runs where organization_id = ${ORG}`;
  await db.sql`delete from engine_reservations where organization_id = ${ORG}`;
  const held = await textHold(0.04, "released");
  assert.equal(held.status, "held");
  if (held.status !== "held") return;
  await settleGenerationCall(db.sql, held.id, { status: "uncertain", error: "timed out", latencyMs: 1 });
  const month = new Date().toISOString().slice(0, 7);
  assert.equal((await sqlLedgerStore(db.sql, ORG).sumForMonth(ORG, month)).reservedUsd, 0.04, "an uncertain hold still counts");
  await db.sql`update model_runs set status = 'released' where id = ${held.id}`;
  assert.equal((await sqlLedgerStore(db.sql, ORG).sumForMonth(ORG, month)).reservedUsd, 0, "a released hold does not count");
});

test("concurrent text holds and video reservations never commit more than the cap between them", async () => {
  await db.sql`delete from model_runs where organization_id = ${ORG}`;
  await db.sql`delete from engine_reservations where organization_id = ${ORG}`;
  const textAttempts = Array.from({ length: 6 }, (_, index) => textHold(0.02, `race-${index}`));
  const videoAttempts = Array.from({ length: 3 }, () => reserveVideo());
  const [texts, videos] = await Promise.all([Promise.all(textAttempts), Promise.all(videoAttempts)]);

  const heldText = texts.filter((result) => result.status === "held").length;
  const reservedVideo = videos.filter((result) => result.reservation.state === "reserved").length;
  const committed = heldText * 0.02 + reservedVideo * VIDEO_RESERVED;
  assert.ok(committed <= CAP + 1e-9, `committed ${committed} must not exceed the cap ${CAP}`);
  assert.ok(reservedVideo <= 1, "one video reservation at most fits beside the rest");
  // With the video reservation accepted, two text holds at most fit beside it. With it paused, text may fill the rest of the month.
  if (reservedVideo === 1) assert.ok(heldText <= 2, "two text holds at most fit beside an accepted video reservation");
  assert.ok(Math.abs((await monthlyHeldUsd(db.sql, ORG)) - committed) < 1e-9, "the stored spend is exactly what was accepted");
});
