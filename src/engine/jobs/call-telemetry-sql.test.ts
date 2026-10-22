// The telemetry row of a paid call, written in the transaction of its settlement on engine_call_telemetry (migration 0110), against a
// real database (PGlite through the test helper). No live call: the provider answers from the recorded chat fixture.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { z } from "zod";
import { budgetReservationSchema, EngineError } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { createGateway } from "../gateway/gateway.ts";
import { structuredChat } from "../gateway/openrouter.ts";
import { paidCall } from "../gateway/paid.ts";
import { TELEMETRY_NOT_RECORDED, type CallTelemetryRecord } from "../gateway/telemetry.ts";
import { json, recorded, staticKeys } from "../gateway/test/recorded.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { scopedLedgerStore } from "./asset-stores-sql.ts";
import { startEngineRequest } from "./orchestrator-sql.ts";
import { withReservationLedger, sqlLedgerStore } from "./sql-ledger-store.ts";

let db: TestDatabase;

const A = "org_telemetry_a";
const B = "org_telemetry_b";
const REQUEST = FIXTURE_IDS.request;
const RESERVATION = fixtureId("res_", 91);
const NOW = "2026-10-22T10:00:00.000Z";
const SCHEMA = z.object({ properties: z.array(z.string()) });
const fixture = JSON.parse(readFileSync(new URL("../gateway/test/fixtures/openrouter-chat.json", import.meta.url), "utf8")) as object;

/** A clock that moves 250 ms on every reading, so one provider request measures 250 ms. */
function steppingClock(): () => number {
  let next = 5_000;
  return () => {
    const now = next;
    next += 250;
    return now;
  };
}

/** One chat call through paidCall on the scoped ledger of the reservation, with the given route model. */
async function settleChat(model?: string, idempotencyKey = "sha256:tel-call") {
  const gateway = createGateway({
    transport: recorded([json(200, fixture)]).transport,
    credentials: staticKeys({ openrouter: "sk-or-test" }),
    now: steppingClock(),
  });
  const base = gateway.route("llm.check");
  const route = model === undefined ? base : { ...base, model };
  const outcome = await paidCall(
    {
      ledger: scopedLedgerStore(db.sql, A, RESERVATION),
      reservationId: RESERVATION,
      stage: "plan",
      route,
      estimateUsd: 0.01,
      idempotencyKey,
      at: NOW,
    },
    async () => {
      const answer = await structuredChat(gateway, {
        organizationId: A,
        capability: "llm.check",
        route,
        messages: [{ role: "user", content: "Classify." }],
        schema: SCHEMA,
        schemaName: "request_properties",
        maxTokens: 200,
      });
      return { value: answer.value, actualUsd: answer.usage.costUsd };
    },
  );
  return outcome;
}

async function ledgerRow(idempotencyKey: string): Promise<{ id: string; actual_usd: unknown; settlement: string | null } | undefined> {
  const rows = await db.sql<{ id: string; actual_usd: unknown; settlement: string | null }>`
    select id, actual_usd, settlement from engine_ledger where organization_id = ${A} and idempotency_key = ${idempotencyKey}
  `;
  return rows[0];
}

async function telemetryRows(entryId: string) {
  return db.sql<{
    organization_id: string;
    provider: string;
    model: string;
    generation_id: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    latency_ms: number | null;
    response_cost_usd: unknown;
  }>`
    select organization_id, provider, model, generation_id, prompt_tokens, completion_tokens, latency_ms, response_cost_usd
    from engine_call_telemetry where ledger_entry_id = ${entryId}
  `;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, A, "brand_telemetry_a");
  await seedWorkspace(db.sql, B, "brand_telemetry_b");
  await startEngineRequest(db.sql, {
    organizationId: A,
    brandId: "brand_telemetry_a",
    requestId: REQUEST,
    formatId: "fmt_telemetry",
    priority: "normal",
    cachedDna: true,
    variantCount: 0,
    requestArtifactId: fixtureId("art_", 911),
  });
  await sqlLedgerStore(db.sql, A).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: RESERVATION,
      requestId: REQUEST,
      workspaceId: A,
      mode: "cap",
      lines: [{ stage: "plan", estimateUsd: 1 }],
      estimateUsd: 1,
      redoAllowanceUsd: 0,
      reservedUsd: 1,
      state: "reserved",
      createdAt: NOW,
    }),
  );
});

after(async () => {
  await db.close();
});

test("the settlement and its telemetry row are written together, in one transaction", async () => {
  const outcome = await settleChat(undefined, "sha256:tel-together");
  assert.equal(outcome.status, "done");
  const entry = await ledgerRow("sha256:tel-together");
  assert.equal(Number(entry?.actual_usd), 0.001);
  assert.equal(entry?.settlement, "billed");

  const rows = await telemetryRows(entry?.id ?? "");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row?.organization_id, A);
  assert.equal(row?.provider, "openrouter");
  assert.equal(row?.generation_id, "gen-1760440000-abcdefghijklmnopqrst");
  assert.equal(row?.prompt_tokens, 812);
  assert.equal(row?.completion_tokens, 24);
  assert.equal(row?.latency_ms, 250);
  assert.equal(Number(row?.response_cost_usd), 0.001);
});

test("a telemetry row that cannot be written leaves the settlement in place, and later calls still record", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  // A model name longer than the table allows (200 characters): the insert fails its check, and nothing else.
  const tooLong = await settleChat("m".repeat(201), "sha256:tel-too-long");
  assert.equal(tooLong.status, "done");
  const failed = await ledgerRow("sha256:tel-too-long");
  assert.equal(Number(failed?.actual_usd), 0.001, "the bill is kept although its telemetry was refused");
  assert.equal(failed?.settlement, "billed");
  assert.equal((await telemetryRows(failed?.id ?? "")).length, 0);
  assert.equal(warn.mock.calls.length, 1);
  assert.deepEqual(warn.mock.calls[0]?.arguments, [TELEMETRY_NOT_RECORDED]);

  // The transaction is usable after the savepoint was rolled back: the next call settles and records as normal.
  const after = await settleChat(undefined, "sha256:tel-after");
  assert.equal(after.status, "done");
  const next = await ledgerRow("sha256:tel-after");
  assert.equal((await telemetryRows(next?.id ?? "")).length, 1);
});

test("a telemetry row for another workspace is refused and nothing is written", async () => {
  const record: CallTelemetryRecord = {
    ledgerEntryId: "led_not_written",
    organizationId: B,
    provider: "openrouter",
    model: "anthropic/claude-haiku-5.5",
    generationId: null,
    promptTokens: null,
    completionTokens: null,
    latencyMs: 10,
    responseCostUsd: null,
  };
  await assert.rejects(
    withReservationLedger(db.sql, A, RESERVATION, (store) => store.recordCallTelemetry(record)),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_call_telemetry where organization_id = ${B}`;
  assert.equal(rows[0]?.n, 0);
});
