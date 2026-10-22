import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { budgetReservationSchema, type BudgetReservation } from "../contracts/index.ts";
import { memoryLedgerStore } from "../budget/store.ts";
import { createGateway } from "./gateway.ts";
import { paidCall } from "./paid.ts";
import {
  TELEMETRY_NOT_RECORDED,
  callTelemetryOf,
  elapsedMs,
  keepCallTelemetry,
  markSent,
  newProbe,
  newSample,
  noteAnswer,
  probeRequests,
  usdUpToFour,
  type CallTelemetryRecord,
  type RequestSample,
} from "./telemetry.ts";
import { recorded, staticKeys } from "./test/recorded.ts";

const RESERVATION = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AT = "2026-10-14T10:01:00.000Z";

async function ledgerWith(reservedUsd: number) {
  const ledger = memoryLedgerStore();
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION,
    requestId: "req_01JABCDEFGHJKMNPQRSTVWXYZ0",
    workspaceId: "org_1",
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd: reservedUsd }],
    estimateUsd: reservedUsd,
    redoAllowanceUsd: 0,
    reservedUsd,
    state: "reserved",
    createdAt: "2026-10-14T10:00:00.000Z",
  });
  await ledger.createReservation(reservation);
  return ledger;
}

function sample(overrides: Partial<RequestSample> = {}): RequestSample {
  return { ...newSample("openrouter", "org_1"), latencyMs: 250, ...overrides };
}

const CALL = { organizationId: "org_1", provider: "openrouter", model: "anthropic/claude-haiku-5.5" };

describe("usdUpToFour", () => {
  it("rounds up exactly as the ledger settles a verified bill (budget/reconcile.ts billUsdUp)", async () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
    const route = gateway.route("llm.check");
    const bills = [0, 0.00001, 0.00005, 0.0001, 0.0000999999, 0.000932, 0.1, 0.12345, 0.99999999, 1.2345678, 2.5];
    for (const bill of bills) {
      const ledger = await ledgerWith(10);
      const key = `sha256:bill-${bill}`;
      const outcome = await paidCall({ ledger, reservationId: RESERVATION, stage: "plan", route, estimateUsd: 0.0001, idempotencyKey: key, at: AT }, async () => ({
        value: "x",
        actualUsd: bill,
      }));
      assert.equal(outcome.status, "done");
      const entry = await ledger.getEntryByKey(key);
      assert.ok(entry?.actualUsd === usdUpToFour(bill), `bill ${bill}: ledger ${entry?.actualUsd}, telemetry ${usdUpToFour(bill)}`);
    }
  });

  it("rounds a bill already on four decimals to itself, and never down", () => {
    assert.equal(usdUpToFour(0.001), 0.001);
    assert.equal(usdUpToFour(0.00010001), 0.0002);
    assert.equal(usdUpToFour(0.000932), 0.001);
  });
});

describe("callTelemetryOf", () => {
  it("writes no row when no request reached the provider", () => {
    assert.equal(callTelemetryOf([], CALL), null);
  });

  it("gives one sample's values, with the cost rounded up", () => {
    const telemetry = callTelemetryOf([sample({ generationId: "gen-1", promptTokens: 812, completionTokens: 24, costUsd: 0.000932 })], CALL);
    assert.deepEqual(telemetry, {
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
      generationId: "gen-1",
      promptTokens: 812,
      completionTokens: 24,
      latencyMs: 250,
      responseCostUsd: 0.001,
    });
  });

  it("keeps an unreported value as null, never as zero", () => {
    const telemetry = callTelemetryOf([sample({ latencyMs: null })], CALL);
    assert.equal(telemetry?.latencyMs, null);
    assert.equal(telemetry?.promptTokens, null);
    assert.equal(telemetry?.responseCostUsd, null);
    assert.equal(telemetry?.generationId, null);
  });

  it("nulls every measured value when two requests cannot be attributed to one response", () => {
    const telemetry = callTelemetryOf([sample({ latencyMs: 100, costUsd: 0.5 }), sample({ latencyMs: 200, costUsd: 0.5 })], CALL);
    assert.deepEqual(telemetry, {
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
      generationId: null,
      promptTokens: null,
      completionTokens: null,
      latencyMs: null,
      responseCostUsd: null,
    });
  });

  it("writes no row for a request with no organization, or one that belongs to another", () => {
    assert.equal(callTelemetryOf([sample({ organizationId: null })], CALL), null);
    assert.equal(callTelemetryOf([sample({ organizationId: "org_2" })], CALL), null);
  });

  it("nulls the measured values of a request to another provider", () => {
    const telemetry = callTelemetryOf([sample({ provider: "deepgram", latencyMs: 90, costUsd: 0.2 })], CALL);
    assert.equal(telemetry?.provider, "openrouter");
    assert.equal(telemetry?.latencyMs, null);
    assert.equal(telemetry?.responseCostUsd, null);
  });
});

describe("noteAnswer", () => {
  it("keeps only usable ids, counts and amounts", () => {
    const kept = sample();
    noteAnswer(kept, { generationId: "gen-1", promptTokens: 5, completionTokens: 0, costUsd: 0 });
    assert.deepEqual([kept.generationId, kept.promptTokens, kept.completionTokens, kept.costUsd], ["gen-1", 5, 0, 0]);

    const refused = sample();
    noteAnswer(refused, { generationId: "", promptTokens: -1, completionTokens: 1.5, costUsd: Number.NaN });
    assert.deepEqual([refused.generationId, refused.promptTokens, refused.completionTokens, refused.costUsd], [null, null, null, null]);

    const tooBig = sample();
    noteAnswer(tooBig, { generationId: "g".repeat(257), promptTokens: 2 ** 31, completionTokens: null, costUsd: Number.POSITIVE_INFINITY });
    assert.deepEqual([tooBig.generationId, tooBig.promptTokens, tooBig.costUsd], [null, null, null]);
  });
});

describe("elapsedMs", () => {
  it("is the whole milliseconds between two clock readings, and null when they give no usable time", () => {
    assert.equal(elapsedMs(1000, 1250), 250);
    assert.equal(elapsedMs(1000, 1000.4), 0);
    assert.equal(elapsedMs(1250, 1000), null);
    assert.equal(elapsedMs(Number.NaN, 1000), null);
    assert.equal(elapsedMs(0, 3_000_000_000), null);
  });
});

describe("the probe", () => {
  it("keeps a sample marked during its call only, and not one marked after the call settled", async () => {
    const probe = newProbe();
    const late = newSample("openrouter", "org_1");
    const early = newSample("openrouter", "org_1");
    await probeRequests(probe, async () => {
      markSent(early);
      setTimeout(() => markSent(late), 0);
      return "done";
    });
    await delay(5);
    markSent(newSample("openrouter", "org_1"));
    assert.deepEqual(probe.samples, [early]);
    assert.equal(probe.open, false);
  });

  it("keeps nothing outside a call", () => {
    assert.doesNotThrow(() => markSent(newSample("openrouter", "org_1")));
  });
});

describe("keepCallTelemetry", () => {
  const record: CallTelemetryRecord = { ...CALL, ledgerEntryId: "led_1", organizationId: "org_1", generationId: null, promptTokens: null, completionTokens: null, latencyMs: 10, responseCostUsd: null };

  it("does nothing for a store that keeps no telemetry", async () => {
    await assert.doesNotReject(keepCallTelemetry({}, record));
  });

  it("logs a fixed message, and never the error, when the write fails", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    await assert.doesNotReject(
      keepCallTelemetry(
        {
          recordCallTelemetry: async () => {
            throw new Error("connection string postgres://user:sk-or-test@db");
          },
        },
        record,
      ),
    );
    assert.equal(warn.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls[0]?.arguments, [TELEMETRY_NOT_RECORDED]);
  });
});
