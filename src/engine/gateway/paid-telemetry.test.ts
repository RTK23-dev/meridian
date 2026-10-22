// A paid chat call, through the ledger and the telemetry, on the recorded answers in test/fixtures. No test calls a live API.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";
import { budgetReservationSchema, type BudgetReservation } from "../contracts/index.ts";
import { EngineError } from "../contracts/errors.ts";
import { memoryLedgerStore } from "../budget/store.ts";
import { createGateway } from "./gateway.ts";
import { StructuredOutputError, structuredChat } from "./openrouter.ts";
import { paidCall, type LockableLedger } from "./paid.ts";
import { TELEMETRY_NOT_RECORDED, type CallTelemetryRecord } from "./telemetry.ts";
import { json, recorded, staticKeys, type Recorded } from "./test/recorded.ts";
import type { CredentialLookup, CredentialSource } from "./types.ts";

const RESERVATION = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AT = "2026-10-14T10:01:00.000Z";
const KEY = "sk-or-test";
const PROMPT = "Classify the request for the reel: a telltale prompt sentence.";
const SCHEMA = z.object({ properties: z.array(z.enum(["real_product", "person_talking", "text_led"])) });
const GENERATION = "gen-1760440000-abcdefghijklmnopqrst";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./test/fixtures/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

/** A clock that moves 250 ms on every reading, so one provider request measures 250 ms. */
function steppingClock(step = 250): () => number {
  let next = 1_000;
  return () => {
    const now = next;
    next += step;
    return now;
  };
}

/** A credential source that counts its lookups, so a test can show that telemetry adds none. */
function countingKeys(keys: Record<string, string>): CredentialSource & { lookups: number } {
  const source = {
    lookups: 0,
    async get(credentialId: string): Promise<CredentialLookup> {
      source.lookups += 1;
      const secret = keys[credentialId];
      return secret ? { status: "ready", credential: { kind: "api_key", secret } } : { status: "not_connected", reason: `no ${credentialId} key` };
    },
  };
  return source;
}

/**
 * A memory ledger with one reservation. Given a telemetry store, the ledger keeps each row it is given, as a Postgres budget
 * transaction does. Without one, the ledger offers no telemetry at all.
 */
async function ledgerWith(telemetry?: (record: CallTelemetryRecord) => Promise<void>): Promise<LockableLedger> {
  const store = memoryLedgerStore();
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION,
    requestId: "req_01JABCDEFGHJKMNPQRSTVWXYZ0",
    workspaceId: "org_1",
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd: 1 }],
    estimateUsd: 1,
    redoAllowanceUsd: 0,
    reservedUsd: 1,
    state: "reserved",
    createdAt: "2026-10-14T10:00:00.000Z",
  });
  await store.createReservation(reservation);
  if (telemetry === undefined) return store;
  return Object.assign(store, { recordCallTelemetry: telemetry });
}

/** Rows kept by a ledger's telemetry store, in order. */
function keptRows(): { rows: CallTelemetryRecord[]; store: (record: CallTelemetryRecord) => Promise<void> } {
  const rows: CallTelemetryRecord[] = [];
  return {
    rows,
    store: async (record) => {
      rows.push(structuredClone(record));
    },
  };
}

type CallOptions = {
  transport: Recorded["transport"];
  ledger: LockableLedger;
  keys?: CredentialSource;
  organizationId?: string | null;
  clock?: () => number;
  /** Keep a structured-output failure as a settled answer, as the Claude client does. Otherwise it is rethrown. */
  keepInvalid?: boolean;
};

/** One chat call through paidCall, run the way the Claude client runs it: the answer's usage is the call's actual cost. */
async function chatCall(options: CallOptions) {
  const gateway = createGateway({
    transport: options.transport,
    credentials: options.keys ?? staticKeys({ openrouter: KEY }),
    now: options.clock ?? steppingClock(),
  });
  const route = gateway.route("llm.check");
  const outcome = await paidCall(
    { ledger: options.ledger, reservationId: RESERVATION, stage: "plan", route, estimateUsd: 0.01, idempotencyKey: "sha256:call-1", at: AT },
    async () => {
      try {
        const answer = await structuredChat(gateway, {
          organizationId: options.organizationId === undefined ? "org_1" : options.organizationId,
          capability: "llm.check",
          route,
          messages: [
            { role: "system", content: "Classify the request." },
            { role: "user", content: PROMPT },
          ],
          schema: SCHEMA,
          schemaName: "request_properties",
          maxTokens: 200,
        });
        return { value: answer.value, actualUsd: answer.usage.costUsd };
      } catch (error) {
        if (options.keepInvalid === true && error instanceof StructuredOutputError) {
          return { value: null, actualUsd: error.usage?.costUsd ?? null };
        }
        throw error;
      }
    },
  );
  return { outcome, route };
}

function chatWithoutUsage(): Record<string, unknown> {
  const { usage: _usage, ...rest } = fixture("openrouter-chat");
  return rest;
}

function chatAnswer(content: string): Record<string, unknown> {
  const body = fixture("openrouter-chat") as { choices: Array<{ message: { content: string } }> };
  return { ...body, choices: [{ ...body.choices[0], message: { role: "assistant", content } }] };
}

describe("telemetry of a paid chat call", () => {
  it("writes one row with the response's tokens and generation id, its latency, and its cost rounded up", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(200, fixture("openrouter-chat"))]);
    const { outcome, route } = await chatCall({ transport: transport.transport, ledger });

    assert.equal(outcome.status, "done");
    assert.equal(kept.rows.length, 1);
    assert.deepEqual(kept.rows[0], {
      ledgerEntryId: (await ledger.getEntryByKey("sha256:call-1"))?.entryId,
      organizationId: "org_1",
      provider: "openrouter",
      model: route.model,
      generationId: GENERATION,
      promptTokens: 812,
      completionTokens: 24,
      latencyMs: 250,
      responseCostUsd: 0.001,
    });
    // The ledger's bill is the same rounding of the same reported cost (0.000932 up to four decimals).
    assert.equal((await ledger.getEntryByKey("sha256:call-1"))?.actualUsd, 0.001);
  });

  it("writes a row with nulls where the response reported nothing, a latency, and no zero", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(200, chatWithoutUsage())]);
    const { outcome } = await chatCall({ transport: transport.transport, ledger });

    assert.equal(outcome.status, "done");
    assert.equal(kept.rows.length, 1);
    const row = kept.rows[0];
    assert.equal(row?.generationId, GENERATION);
    assert.equal(row?.promptTokens, null);
    assert.equal(row?.completionTokens, null);
    assert.equal(row?.responseCostUsd, null);
    assert.equal(row?.latencyMs, 250);
    for (const value of Object.values(row ?? {})) assert.notEqual(value, 0);
    // No bill was reported, so the ledger keeps the hold and books no actual.
    assert.equal((await ledger.getEntryByKey("sha256:call-1"))?.actualUsd, undefined);
  });

  it("keeps what is known of a failed call that reached the provider, and keeps its hold", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(500, { error: { code: 500, message: "upstream failure" } })]);
    await assert.rejects(chatCall({ transport: transport.transport, ledger }), (error: unknown) => error instanceof EngineError && error.retryable);

    assert.equal(transport.requests.length, 1);
    assert.equal(kept.rows.length, 1);
    const row = kept.rows[0];
    assert.equal(row?.latencyMs, 250);
    assert.equal(row?.generationId, null);
    assert.equal(row?.promptTokens, null);
    assert.equal(row?.completionTokens, null);
    assert.equal(row?.responseCostUsd, null);
    const entry = await ledger.getEntryByKey("sha256:call-1");
    assert.equal(entry?.reservedUsd, 0.01);
    assert.equal(entry?.actualUsd, undefined);
  });

  it("keeps the usage a billed answer reported, even when the answer fails its schema", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(200, chatAnswer("Sure! Here you go."))]);
    const { outcome } = await chatCall({ transport: transport.transport, ledger, keepInvalid: true });

    assert.equal(outcome.status, "done");
    assert.equal(kept.rows.length, 1);
    assert.equal(kept.rows[0]?.promptTokens, 812);
    assert.equal(kept.rows[0]?.completionTokens, 24);
    assert.equal(kept.rows[0]?.responseCostUsd, 0.001);
    assert.equal(kept.rows[0]?.generationId, GENERATION);
    assert.equal((await ledger.getEntryByKey("sha256:call-1"))?.actualUsd, 0.001);
  });

  it("writes no row for a call that never reached the provider", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([]);
    await assert.rejects(chatCall({ transport: transport.transport, ledger, keys: staticKeys({}) }), /not connected/);

    assert.equal(transport.requests.length, 0);
    assert.equal(kept.rows.length, 0);
  });

  it("writes no row for a call with no organization, as the ledger writes none", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(200, fixture("openrouter-chat"))]);
    const { outcome } = await chatCall({ transport: transport.transport, ledger, organizationId: null });

    assert.equal(outcome.status, "done");
    assert.equal(transport.requests.length, 1);
    assert.equal(kept.rows.length, 0);
  });

  it("adds no provider request and no credential lookup", async () => {
    const plainKeys = countingKeys({ openrouter: KEY });
    const plain = recorded([json(200, fixture("openrouter-chat"))]);
    const plainOutcome = await chatCall({ transport: plain.transport, ledger: await ledgerWith(), keys: plainKeys });

    const telemetricKeys = countingKeys({ openrouter: KEY });
    const telemetric = recorded([json(200, fixture("openrouter-chat"))]);
    const telemetricOutcome = await chatCall({
      transport: telemetric.transport,
      ledger: await ledgerWith(async () => undefined),
      keys: telemetricKeys,
    });

    assert.equal(plain.requests.length, 1);
    assert.equal(telemetric.requests.length, plain.requests.length);
    assert.equal(telemetricKeys.lookups, plainKeys.lookups);
    assert.equal(telemetricOutcome.outcome.status, plainOutcome.outcome.status);
  });

  it("keeps the call's result, and writes a null latency rather than a guess, when the clock throws", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(200, fixture("openrouter-chat"))]);
    const { outcome } = await chatCall({
      transport: transport.transport,
      ledger,
      clock: () => {
        throw new Error("clock is down");
      },
    });

    assert.equal(outcome.status, "done");
    assert.equal(kept.rows.length, 1);
    assert.equal(kept.rows[0]?.latencyMs, null);
    assert.equal(kept.rows[0]?.responseCostUsd, 0.001);
    assert.equal((await ledger.getEntryByKey("sha256:call-1"))?.actualUsd, 0.001);
  });

  it("keeps the call's result and its ledger row when the telemetry insert throws", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const plainLedger = await ledgerWith();
    const plain = await chatCall({ transport: recorded([json(200, fixture("openrouter-chat"))]).transport, ledger: plainLedger });

    const failingLedger = await ledgerWith(async () => {
      throw new Error(`insert failed for ${KEY} with ${PROMPT}`);
    });
    const failing = await chatCall({ transport: recorded([json(200, fixture("openrouter-chat"))]).transport, ledger: failingLedger });

    assert.equal(plain.outcome.status, "done");
    assert.equal(failing.outcome.status, "done");
    if (plain.outcome.status === "done" && failing.outcome.status === "done") {
      assert.deepEqual(failing.outcome.value, plain.outcome.value);
      assert.equal(failing.outcome.entry.actualUsd, plain.outcome.entry.actualUsd);
      assert.equal(failing.outcome.entry.settlement, plain.outcome.entry.settlement);
      assert.equal(failing.outcome.entry.reservedUsd, plain.outcome.entry.reservedUsd);
    }
    // The one log line is the fixed message: no error text, no key and no prompt.
    assert.equal(warn.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls[0]?.arguments, [TELEMETRY_NOT_RECORDED]);
  });

  it("keeps the call's own error when the telemetry insert throws on a failed call", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const ledger = await ledgerWith(async () => {
      throw new Error("insert failed");
    });
    await assert.rejects(chatCall({ transport: recorded([json(503, { error: { code: 503 } })]).transport, ledger }), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.kind, "provider");
      return true;
    });
    assert.equal((await ledger.getEntryByKey("sha256:call-1"))?.reservedUsd, 0.01);
  });

  it("gives the row the call's organization, and stores neither the prompt nor the key", async () => {
    const kept = keptRows();
    const ledger = await ledgerWith(kept.store);
    const transport = recorded([json(200, fixture("openrouter-chat"))]);
    await chatCall({ transport: transport.transport, ledger });

    assert.equal(kept.rows[0]?.organizationId, "org_1");
    const stored = JSON.stringify(kept.rows);
    assert.doesNotMatch(stored, /Classify the request/);
    assert.doesNotMatch(stored, /telltale/);
    assert.doesNotMatch(stored, new RegExp(KEY));
    // The fake transport did receive the prompt and the key, so the checks above are not vacuous.
    assert.match(String(transport.requests[0]?.body), /telltale/);
    assert.match(JSON.stringify(transport.requests[0]?.headers), new RegExp(KEY));
  });
});
