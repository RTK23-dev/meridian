import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { deps, gatewayFor, json, ledgerWith, REQUEST_ID, RESERVATION_ID, WORKSPACE } from "../claude/test/helpers.ts";
import { EngineError, type ProductionRequest } from "../contracts/index.ts";
import { productionRequestFixture } from "../contracts/fixtures/index.ts";
import { writeVariantLines, writerInputFor, type WriterCall } from "./writer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_ANSWER = readFileSync(join(HERE, "test", "fixtures", "openrouter-variant-writer-hook.json"), "utf8");
const CLAIMS = ["Makes four smoothies in under two minutes"];
const FIXTURE_REQUEST = productionRequestFixture as ProductionRequest;

/** A recorded chat answer whose content is the given object, in the shape the gateway parses. */
function chat(content: unknown) {
  return json(200, {
    id: "gen-recorded-variant-writer-0001",
    model: "recorded/variant-writer",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 1180, completion_tokens: 46, total_tokens: 1226, cost: 0.0021 },
  });
}

function hookCall(request: ProductionRequest = FIXTURE_REQUEST): WriterCall {
  return {
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE,
    reservationId: RESERVATION_ID,
    attempt: 1,
    input: writerInputFor({ request, change: { kind: "hook", index: 2, count: 3 }, claims: CLAIMS }),
  };
}

/** The fixture request with its hook beat saying a number, so a line that drops it breaks the contract. */
function numericHookRequest(): ProductionRequest {
  const request = structuredClone(FIXTURE_REQUEST);
  request.script.beats = request.script.beats.map((beat) =>
    beat.beatId === "b1" ? { ...beat, text: "Your counter has lied to you 2 times." } : beat,
  );
  return request;
}

describe("the variant writer's input (Bible 6.13)", () => {
  it("a hook writes its hook beat only, in the request's language, as one line of its row", () => {
    const input = writerInputFor({ request: FIXTURE_REQUEST, change: { kind: "hook", index: 2, count: 3 }, claims: CLAIMS });
    assert.deepEqual(input.beats.map((beat) => beat.beatId), ["b1"]);
    assert.equal(input.targetLanguage, "en");
    assert.deepEqual(input.variant, { attribute: "hook", label: "hook line 2 of 3" });
    assert.deepEqual(input.claims, CLAIMS);
  });

  it("a language writes every beat, in the target language", () => {
    const input = writerInputFor({ request: FIXTURE_REQUEST, change: { kind: "language", language: "de" }, claims: CLAIMS });
    assert.equal(input.beats.length, FIXTURE_REQUEST.script.beats.length);
    assert.equal(input.targetLanguage, "de");
    assert.deepEqual(input.variant, { attribute: "language", label: "language de" });
  });

  it("a hook is refused, before any call, when the request has no hook beat", () => {
    const request = structuredClone(FIXTURE_REQUEST);
    request.script.beats = request.script.beats.filter((beat) => beat.role !== "hook");
    assert.throws(
      () => writerInputFor({ request, change: { kind: "hook", index: 1, count: 1 }, claims: CLAIMS }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("one writer call through the Claude client (Bible 6.13, 11, 14.1)", () => {
  it("calls the writer once, returns its lines, and pays for the call on the request's reservation", async () => {
    const ledger = await ledgerWith(1);
    const { gateway, requests } = gatewayFor([json(200, JSON.parse(HOOK_ANSWER))]);
    const outcome = await writeVariantLines(deps(gateway, ledger), hookCall());
    assert.deepEqual(outcome, {
      status: "done",
      lines: [{ beatId: "b1", text: "Your counter has been lying to you all along." }],
      calls: 1,
    });
    assert.equal(requests.length, 1);
    const entries = await ledger.listEntries(RESERVATION_ID);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, "variant_writer");
  });

  it("retries once when the answer drops a number of its beat, under a new key, and uses the retry's answer", async () => {
    const ledger = await ledgerWith(1);
    const { gateway, requests } = gatewayFor([
      chat({ lines: [{ beatId: "b1", text: "Your counter has lied to you." }] }),
      chat({ lines: [{ beatId: "b1", text: "Your counter has lied to you 2 times." }] }),
    ]);
    const outcome = await writeVariantLines(deps(gateway, ledger), hookCall(numericHookRequest()));
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.deepEqual(outcome.lines, [{ beatId: "b1", text: "Your counter has lied to you 2 times." }]);
    assert.equal(outcome.calls, 2);
    assert.equal(requests.length, 2);
    const keys = (await ledger.listEntries(RESERVATION_ID)).map((entry) => entry.idempotencyKey);
    assert.equal(new Set(keys).size, 2);
  });

  it("fails the writer, with the checks named, when both answers break the contract", async () => {
    const ledger = await ledgerWith(1);
    const { gateway } = gatewayFor([
      chat({ lines: [{ beatId: "b1", text: "Your counter has lied to you." }] }),
      chat({ lines: [{ beatId: "b9", text: "Not a beat." }] }),
    ]);
    const outcome = await writeVariantLines(deps(gateway, ledger), hookCall(numericHookRequest()));
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.match(outcome.reason, /did not match its contract after 2 attempts/);
  });

  it("makes no call and says so when the provider is not connected", async () => {
    const ledger = await ledgerWith(1);
    const { gateway, requests } = gatewayFor([], { keys: {} });
    const outcome = await writeVariantLines(deps(gateway, ledger), hookCall());
    assert.equal(outcome.status, "not_connected");
    assert.equal(requests.length, 0);
    assert.equal((await ledger.listEntries(RESERVATION_ID)).length, 0);
  });
});
