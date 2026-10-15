import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/index.ts";
import type { JournalEntry } from "../claude/journal.ts";
import { requestCallsOf } from "./calls.ts";

const RES = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";

function answered(overrides: Partial<JournalEntry["call"] & object> = {}, entry: Partial<JournalEntry> = {}): JournalEntry {
  const key = entry.idempotencyKey ?? "planner:1";
  const version = entry.promptVersion ?? "planner@1";
  return {
    status: "answered",
    idempotencyKey: key,
    retryOfKey: null,
    role: "planner",
    stage: "plan",
    promptVersion: version,
    model: "anthropic/claude-opus-5.5",
    reservationId: RES,
    answer: {},
    refusedReason: null,
    call: {
      idempotencyKey: key,
      ledgerEntryId: "led_01JABCDEFGHJKMNPQRSTVWXYZ0",
      promptVersion: version,
      model: "anthropic/claude-opus-5.5",
      answeredBy: "anthropic/claude-opus-5.5",
      generationId: "gen-1",
      promptTokens: 19000,
      completionTokens: 3300,
      costUsd: 0.142,
      actualIsEstimate: false,
      verdict: "answered",
      issues: [],
      ...overrides,
    },
    ...entry,
  };
}

describe("the role calls of a request, as the manifest holds them", () => {
  it("lists each answered call with its role, prompt version, model, tokens and cost", () => {
    const calls = requestCallsOf([answered()]);
    assert.deepEqual(calls.roleCalls, [
      {
        role: "planner",
        promptVersion: "planner@1",
        model: "anthropic/claude-opus-5.5",
        answeredBy: "anthropic/claude-opus-5.5",
        generationId: "gen-1",
        tokens: { prompt: 19000, completion: 3300 },
        costUsd: 0.142,
        actualIsEstimate: false,
        verdict: "answered",
      },
    ]);
    assert.deepEqual(calls.promptVersions, { planner: "planner@1" });
    assert.equal(calls.unanswered, 0);
  });

  it("counts a pending call as unanswered and does not list it, and does not list a refused one", () => {
    const pending: JournalEntry = {
      ...answered({}, { idempotencyKey: "segment:1", role: "segmenter", promptVersion: "segmenter@1" }),
      status: "pending",
      call: null,
    };
    const refused: JournalEntry = {
      ...answered({}, { idempotencyKey: "critic:1", role: "critic_take", promptVersion: "critic_take@1" }),
      status: "refused",
      call: null,
      refusedReason: "the reservation is paused",
    };
    const calls = requestCallsOf([answered(), pending, refused]);
    assert.equal(calls.roleCalls.length, 1);
    assert.equal(calls.unanswered, 1);
    assert.deepEqual(calls.promptVersions, { planner: "planner@1", segmenter: "segmenter@1" }, "a refused call never ran, so its version is not used");
  });

  it("refuses a role that ran with two prompt versions in one request", () => {
    assert.throws(
      () => requestCallsOf([answered({}, { idempotencyKey: "a" }), answered({}, { idempotencyKey: "b", promptVersion: "planner@2" })]),
      (error: unknown) => error instanceof EngineError && error.kind === "internal",
    );
  });

  it("refuses an invalid answer that the provider billed at a known cost, because the contract holds it as the estimate", () => {
    const billedInvalid = answered(
      { verdict: "invalid_answer", answeredBy: null, costUsd: 0.05, actualIsEstimate: false, promptTokens: 2000, completionTokens: 90 },
      { idempotencyKey: "director:1", role: "director_check", promptVersion: "director_check@1" },
    );
    assert.throws(() => requestCallsOf([billedInvalid]), (error: unknown) => {
      return error instanceof EngineError && error.kind === "internal" && /does not fit the manifest contract/.test(error.message);
    });
  });

  it("lists an invalid answer whose cost is unknown, held as the estimate", () => {
    const unknownInvalid = answered(
      { verdict: "invalid_answer", answeredBy: null, costUsd: null, actualIsEstimate: true, promptTokens: null, completionTokens: null },
      { idempotencyKey: "director:2", role: "director_check", promptVersion: "director_check@1" },
    );
    const calls = requestCallsOf([unknownInvalid]);
    assert.equal(calls.roleCalls[0]?.verdict, "invalid_answer");
    assert.equal(calls.roleCalls[0]?.costUsd, null);
    assert.equal(calls.roleCalls[0]?.actualIsEstimate, true);
  });
});
