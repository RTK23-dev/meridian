// The engine's API for Meridian (lead tasks I1 to I3), on PGlite or PostgreSQL with no provider call. Each test uses its own request ids and
// its own workspace rows, and the fixtures are the engine's contract fixtures. Nothing reads a key: the credential sources are scripted.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FIXTURE_IDS, productionRequestFixture } from "../contracts/fixtures/index.ts";
import { EngineError, newId, productionRequestSchema, type ProductionRequest } from "../contracts/index.ts";
import type { WorkspaceMonthBudget } from "../jobs/handlers/estimate-reserve.ts";
import { readArtifact } from "../jobs/artifact-store.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { ENGINE_STAGES } from "../jobs/registry.ts";
import type { EngineRuntime, StageHandler } from "../jobs/types.ts";
import type { CredentialLookup } from "../gateway/types.ts";
import { chainWorld, drain, startChainRequest } from "../ops/test/chain.ts";
import { sqlLedgerStore } from "../jobs/sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import {
  engineReadiness,
  engineRequestStatus,
  engineSpendOf,
  openEngineReviewItems,
  engineRequestFeed,
  pauseEngineSpend,
  quoteEngineShotRemake,
  remakeEngineShot,
  requestProblems,
  reservationState,
  startEngineRequest,
  type EngineReadinessPorts,
  type RemakePorts,
} from "./index.ts";

const ORG = "org_api";
const OTHER_ORG = "org_api_other";
const BRAND = "brand_api";
const OTHER_BRAND = "brand_api_two";
const NOW = "2026-10-15T10:00:00.000Z";

let database: TestDatabase | undefined;

async function db(): Promise<TestDatabase> {
  if (database) return database;
  database = await createTestDatabase();
  await seedWorkspace(database.sql, ORG, BRAND);
  await seedWorkspace(database.sql, OTHER_ORG, "brand_api_other");
  await database.sql`
    insert into brands (id, organization_id, name, created_by) values (${OTHER_BRAND}, ${ORG}, ${OTHER_BRAND}, 'test')
    on conflict (id) do nothing
  `;
  return database;
}

after(async () => {
  await database?.close();
});

/** A request the engine's schema accepts, in the workspace named. Its id is new, so no test shares a request with another. */
function requestFor(organizationId: string): ProductionRequest {
  return { ...productionRequestFixture, workspaceId: organizationId, requestId: newId("req_") };
}

async function startIn(sql: TestDatabase["sql"], organizationId: string, brandId: string, request: ProductionRequest): Promise<void> {
  const started = await startEngineRequest(sql, { organizationId, brandId, request, variantCount: 0, now: NOW });
  assert.equal(started.status, "started");
}

async function reserve(sql: TestDatabase["sql"], organizationId: string, requestId: string, usd: number): Promise<string> {
  const id = newId("res_");
  await sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, paused_reason, created_at)
    values (${id}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', ${usd}, 0, ${usd}, null, now())
  `;
  return id;
}

test("a request is started once: its production request is stored, intake is queued, and the request reads as queued", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  const started = await startEngineRequest(sql, { organizationId: ORG, brandId: BRAND, request, variantCount: 0, now: NOW });
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  assert.equal(started.requestId, request.requestId);

  const stored = await readArtifact(sql, { organizationId: ORG, artifactId: started.requestArtifactId });
  assert.equal(stored.envelope.type, "production_request");
  assert.equal(stored.envelope.requestId, request.requestId);
  assert.deepEqual(await engineRequestStatus(sql, ORG, request.requestId), { status: "queued", requestId: request.requestId });

  const [jobs] = await sql<{ n: number }>`select count(*)::int as n from jobs where organization_id = ${ORG} and job_type = 'engine.intake'`;
  assert.ok((jobs?.n ?? 0) >= 1, "intake is queued on the worker's queue");
});

test("a request id already in the workspace is reported as existing, and nothing new is written", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, BRAND, request);
  const again = await startEngineRequest(sql, { organizationId: ORG, brandId: BRAND, request, variantCount: 0, now: NOW });
  assert.deepEqual(again, { status: "exists", requestId: request.requestId });
  const [rows] = await sql<{ n: number }>`select count(*)::int as n from engine_requests where id = ${request.requestId}`;
  assert.equal(rows?.n, 1);
});

test("a request that fails the engine's schema, or names another workspace, is refused before any row exists", async () => {
  const { sql } = await db();
  const incomplete = { ...requestFor(ORG), constraints: undefined };
  assert.ok(requestProblems(incomplete).includes("constraints"), "the failing path is named");
  await assert.rejects(
    startEngineRequest(sql, { organizationId: ORG, brandId: BRAND, request: incomplete, variantCount: 0 }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );

  const other = requestFor(OTHER_ORG);
  await assert.rejects(
    startEngineRequest(sql, { organizationId: ORG, brandId: BRAND, request: other, variantCount: 0 }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  const [rows] = await sql<{ n: number }>`select count(*)::int as n from engine_requests where id = ${other.requestId}`;
  assert.equal(rows?.n, 0, "a refused request leaves no row");
});

test("a request is read only in its own workspace", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, BRAND, request);
  assert.equal(await engineRequestStatus(sql, OTHER_ORG, request.requestId), null, "another workspace sees no such request");
});

test("engine spend is the billed actual on the ledger, and a held call with no bill yet is pending, not zero dollars", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, BRAND, request);
  const reservationId = await reserve(sql, ORG, request.requestId, 1);
  await sql`
    insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, idempotency_key, at)
    values (${newId("res_")}, ${ORG}, ${request.requestId}, ${reservationId}, 'produce_shot', 'fixture', 'fixture', 0.4, 0.4, 0.4, 'billed', ${`k-${request.requestId}-a`}, now())
  `;
  await sql`
    insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, idempotency_key, at)
    values (${newId("res_")}, ${ORG}, ${request.requestId}, ${reservationId}, 'produce_shot', 'fixture', 'fixture', 0.2, 0.2, null, null, ${`k-${request.requestId}-b`}, now())
  `;
  await sql`
    insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, idempotency_key, at)
    values (${newId("res_")}, ${ORG}, ${request.requestId}, ${reservationId}, 'produce_shot', 'fixture', 'fixture', 0.1, 0.1, 0, 'confirmed_absent', ${`k-${request.requestId}-c`}, now())
  `;

  const spend = await engineSpendOf(sql, ORG, [request.requestId]);
  assert.equal(spend.totalMicros, 400_000, "only the billed actual is spend; a confirmed absence costs 0");
  assert.equal(spend.dailyMicros, 400_000);
  assert.equal(spend.pendingCalls, 1, "the held call with no bill is pending; a confirmed absence is settled, not pending");
  assert.deepEqual(await engineSpendOf(sql, ORG, []), { totalMicros: 0, dailyMicros: 0, pendingCalls: 0 });
});

test("pausing a request holds its live reservations once, and refuses a pause with no reason", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, BRAND, request);
  const reservationId = await reserve(sql, ORG, request.requestId, 0.5);
  assert.equal(await reservationState(sql, ORG, reservationId), "reserved");

  assert.equal(await pauseEngineSpend(sql, ORG, request.requestId, "The Factory run reached its spend cap."), 1);
  assert.equal(await reservationState(sql, ORG, reservationId), "paused");
  assert.equal(await pauseEngineSpend(sql, ORG, request.requestId, "The Factory run reached its spend cap."), 0, "a paused reservation is not paused twice");
  await assert.rejects(
    pauseEngineSpend(sql, ORG, request.requestId, "   "),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("the open review items of a brand are listed with the engine's reason, and another brand's or workspace's are not", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, OTHER_BRAND, request);
  await sql`
    insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail)
    values (${newId("res_")}, ${ORG}, ${request.requestId}, 'escalation', 'open', 'shot_fixture',
      'check_take failed its take gate after 2 redos', '{"stage":"check_take"}')
  `;
  await sql`
    insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail, resolved_at)
    values (${newId("res_")}, ${ORG}, ${request.requestId}, 'dead_letter', 'resolved', 'shot_fixture', 'resolved earlier', '{}', now())
  `;

  const items = await openEngineReviewItems(sql, ORG, OTHER_BRAND);
  assert.equal(items.length, 1, "the resolved item is not open");
  assert.equal(items[0]?.kind, "escalation");
  assert.equal(items[0]?.stage, "check_take");
  assert.equal(items[0]?.reason, "check_take failed its take gate after 2 redos");
  assert.deepEqual(await openEngineReviewItems(sql, ORG, BRAND), [], "another brand of the workspace lists none");
  assert.deepEqual(await openEngineReviewItems(sql, OTHER_ORG, OTHER_BRAND), [], "another workspace lists none");
});

const READY: CredentialLookup = { status: "ready", credential: { kind: "api_key", secret: "fixture-not-a-key" } };
const NOT_SAVED: CredentialLookup = { status: "not_connected", reason: "no key is saved (fixture)" };

function keysReady(...ready: string[]): EngineReadinessPorts["credentials"] {
  return {
    get: async (credentialId: string): Promise<CredentialLookup> => (ready.includes(credentialId) ? READY : NOT_SAVED),
  };
}

function budgetOf(usd: number | null): EngineReadinessPorts["monthBudget"] {
  return {
    monthBudget: async (): Promise<WorkspaceMonthBudget> =>
      usd === null ? { status: "not_connected", reason: "no monthly video budget is set (fixture)" } : { status: "known", usd },
  };
}

function everyHandler(): EngineRuntime["handlers"] {
  const stub: StageHandler = {
    async run() {
      throw new Error("not run by this test");
    },
  };
  return Object.fromEntries(ENGINE_STAGES.map((stage) => [stage, stub] as const)) as EngineRuntime["handlers"];
}

function reasonsOf(result: Awaited<ReturnType<typeof engineReadiness>>): string[] {
  return result.status === "not_connected" ? result.reasons : [];
}

test("the engine is ready only with a monthly budget, the model key and a render key, and a handler for every stage; otherwise it says why", async () => {
  const full: EngineReadinessPorts = { monthBudget: budgetOf(100), credentials: keysReady("openrouter", "heygen"), runtime: { handlers: everyHandler() } };
  assert.deepEqual(await engineReadiness(ORG, full), { status: "ready" });

  const noBudget = reasonsOf(await engineReadiness(ORG, { ...full, monthBudget: budgetOf(null) }));
  assert.ok(noBudget.some((reason) => reason.startsWith("Monthly video budget:")), noBudget.join("; "));

  const noKeys = reasonsOf(await engineReadiness(ORG, { ...full, credentials: keysReady() }));
  assert.ok(noKeys.some((reason) => reason.startsWith("OpenRouter:")), noKeys.join("; "));
  assert.ok(noKeys.some((reason) => reason.startsWith("Render: neither HyperFrames")), noKeys.join("; "));

  const noHandlers = reasonsOf(await engineReadiness(ORG, { ...full, runtime: { handlers: {} } }));
  assert.ok(noHandlers.some((reason) => reason.startsWith("Engine stages with no handler")), noHandlers.join("; "));
});

test("a shot of a video that is still being made is not remade: the refusal says why, and no money is held", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, BRAND, request);
  const ports: RemakePorts = { monthBudget: { monthBudget: async () => ({ status: "known", usd: 1000 }) } };

  const outcome = await remakeEngineShot(sql, { organizationId: ORG, requestId: request.requestId, shotId: "shot_0000000000000000000000000", directive: "a close-up", now: NOW }, ports);
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.ok(outcome.reasons.some((reason) => /not in this video|still being made/.test(reason)), outcome.reasons.join("; "));
  const [held] = await sql<{ n: number }>`select count(*)::int as n from engine_reservations where request_id = ${request.requestId}`;
  assert.equal(held?.n, 0, "a refused remake reserves nothing");
});

test("the feed of a video that has not been delivered reads revision 0 and no shot rows yet", async () => {
  const { sql } = await db();
  const request = requestFor(ORG);
  await startIn(sql, ORG, BRAND, request);
  const feed = await engineRequestFeed(sql, ORG, request.requestId);
  assert.ok(feed);
  assert.equal(feed?.revision, 0);
  assert.deepEqual(feed?.shots, []);
});

describe("a remake's quote on a delivered video: the month is held to the line the reservation makes (D17)", () => {
  const QUOTE_ORG = "org_api_quote";
  const QUOTE_BRAND = "brand_api_quote";
  const QUOTE_NOW = "2026-10-18T10:00:00.000Z";
  let quoteDb: TestDatabase;
  let requestId = "";
  let shot = "";
  let firstReservationId = "";
  const reservationsOf = async (): Promise<number> => {
    const [row] = await quoteDb.sql<{ n: number }>`select count(*)::int as n from engine_reservations where request_id = ${requestId}`;
    return row?.n ?? 0;
  };

  before(async () => {
    quoteDb = await createTestDatabase();
    await seedWorkspace(quoteDb.sql, QUOTE_ORG, QUOTE_BRAND);
    const world = await chainWorld(quoteDb.sql, QUOTE_ORG);
    const started = await startChainRequest(world, { slot: 6, brandId: QUOTE_BRAND, formatId: "fmt_api_quote", priority: "normal", variantCount: 0 });
    await drain(quoteDb.sql, world.runtime, QUOTE_ORG);
    requestId = started.requestId;
    firstReservationId = started.reservationId;
    const ids = world.requests.get(requestId)?.ids;
    assert.ok(ids, "the chain world holds the request's ids");
    shot = ids.id(FIXTURE_IDS.shot1);
    assert.equal((await engineRequestStatus(quoteDb.sql, QUOTE_ORG, requestId))?.status, "delivered");
  });

  after(async () => {
    await quoteDb.close();
  });

  test("a month with room for the remake quotes it as fitting; a month a sliver above its spend, or at its line, does not fit, and the quote reserves nothing", async () => {
    const sql = quoteDb.sql;
    const reservedBefore = await reservationsOf();
    // The month's committed spend, read the way the quote reads it.
    const committed = await sqlLedgerStore(sql, QUOTE_ORG).committedForMonth(QUOTE_ORG, QUOTE_NOW.slice(0, 7));
    const quoteWith = (usd: number) =>
      quoteEngineShotRemake(sql, { organizationId: QUOTE_ORG, requestId, shotId: shot, now: QUOTE_NOW }, { monthBudget: { monthBudget: async () => ({ status: "known", usd }) } });

    const roomy = await quoteWith(committed + 1000);
    assert.equal(roomy.status, "quoted", roomy.status === "refused" ? roomy.reasons.join("; ") : "");
    if (roomy.status === "quoted") assert.deepEqual([roomy.fits, roomy.reasons], [true, []], roomy.reasons.join("; "));

    // The month is below its line, but the remake's hold is larger than the sliver that is left under it.
    const tight = await quoteWith(committed + 0.0001);
    assert.equal(tight.status, "quoted", tight.status === "refused" ? tight.reasons.join("; ") : "");
    if (tight.status === "quoted") {
      assert.ok(tight.reservedUsd > 0.0001, "the remake's hold is larger than the sliver above the spend");
      assert.equal(tight.fits, false);
      assert.match(tight.reasons.join("; "), /^the remake would take the workspace month to \$[0-9.]+, above its \$[0-9.]+ budget$/);
    }

    // A month at its line refuses the remake, as a call at its line is refused (D17).
    const atLine = await quoteWith(committed);
    assert.equal(atLine.status, "quoted", atLine.status === "refused" ? atLine.reasons.join("; ") : "");
    if (atLine.status === "quoted") {
      assert.equal(atLine.fits, false);
      assert.match(atLine.reasons.join("; "), /^the workspace month has committed \$[0-9.]+, at or above its \$[0-9.]+ budget, so the remake does not start$/);
    }

    assert.equal(await reservationsOf(), reservedBefore, "a quote reserves nothing");
  });

  test("a second remake whose request's first reservation already spent the whole budget is quoted as not fitting, though its own hold fits alone; nothing is reserved", async () => {
    const sql = quoteDb.sql;
    const ledger = sqlLedgerStore(sql, QUOTE_ORG);
    const stored = await readEngineRequest(sql, QUOTE_ORG, requestId);
    const requestArtifactId = stored?.state.artifacts.request;
    assert.ok(requestArtifactId, "the request's record is stored");
    const requestRecord = productionRequestSchema.parse((await readArtifact(sql, { organizationId: QUOTE_ORG, artifactId: requestArtifactId })).envelope.body);
    const budgetUsd = requestRecord.constraints.budgetUsd;

    // The first reservation settles at what the request has left, so the request has spent its whole budget across its reservations.
    const spentBefore = await ledger.committedForRequest(requestId);
    const left = Math.round((budgetUsd - spentBefore) * 10000) / 10000;
    assert.ok(left > 0, `the request has budget left to spend: it has spent $${spentBefore} of $${budgetUsd}`);
    await sql`
      insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, idempotency_key, at)
      values (${newId("led_")}, ${QUOTE_ORG}, ${requestId}, ${firstReservationId}, 'produce_shot', 'fixture', 'fixture', ${left}, ${left}, ${left}, 'billed', ${`request-fill-${requestId}`}, ${QUOTE_NOW})
    `;
    assert.ok((await ledger.committedForRequest(requestId)) >= budgetUsd - 1e-9, "the first reservation has spent the request's budget");

    // The second remake's own hold fits the request's budget on its own, so only the spend the first reservation already made refuses it.
    const reservedBefore = await reservationsOf();
    const second = await quoteEngineShotRemake(sql, { organizationId: QUOTE_ORG, requestId, shotId: shot, now: QUOTE_NOW }, { monthBudget: { monthBudget: async () => ({ status: "known", usd: 1_000_000 }) } });
    assert.equal(second.status, "quoted", second.status === "refused" ? second.reasons.join("; ") : "");
    if (second.status === "quoted") {
      assert.ok(second.reservedUsd <= budgetUsd, "the remake's own hold is within the request's budget");
      assert.equal(second.fits, false);
      assert.match(second.reasons.join("; "), /^the request has committed \$[0-9.]+, at or above its \$[0-9.]+ budget, so the remake does not start$/);
    }
    assert.equal(await reservationsOf(), reservedBefore, "a quote reserves nothing");
  });
});
