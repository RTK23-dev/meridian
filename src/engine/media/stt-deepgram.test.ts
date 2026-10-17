// The Deepgram adapter against recorded answers (synthetic, see test/deepgram-fixtures.ts). No call is made: a scripted gateway
// returns each recorded answer in order and records every request, so the tests check what would have been sent, what is stored,
// and how each refusal or failure is settled through the ledger.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetReservationFixture } from "../contracts/fixtures/index.ts";
import { EngineError } from "../contracts/errors.ts";
import { roundUsd } from "../contracts/money.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import type { Gateway, GatewayCall, GatewayResult, ResolvedRoute } from "../gateway/gateway.ts";
import type { HttpResponse } from "../gateway/types.ts";
import {
  billAnswer,
  billOk,
  DEEPGRAM_AUDIO_MS,
  DEEPGRAM_BILL_USD,
  DEEPGRAM_PROJECT_ID,
  DEEPGRAM_REQUEST_ID,
  DEEPGRAM_WORDS,
  jsonResponse,
  listenOk,
  refusal,
} from "./test/deepgram-fixtures.ts";
import { pricePerMinuteOf } from "./stt-connection.ts";
import { deepgramForRoute, deepgramSpeechToText } from "./stt-deepgram.ts";
import {
  attemptKey,
  SttCallError,
  sttIdempotencyKey,
  transcribeMetered,
  type SttRequest,
} from "./stt.ts";
import { mediaConfig } from "./config.ts";

// The provider spec the gateway will list for Deepgram needs the scheme "Token" (Authorization: Token <key>). The gateway's AuthSpec
// allows only "Bearer" and null today (gateway/types.ts, eng-pipeline), so this fixture names no auth. The adapter never reads it.
const ROUTE: ResolvedRoute = {
  capability: "stt",
  provider: {
    id: "deepgram",
    baseUrl: "https://deepgram.test",
    auth: { kind: "none" },
    credentialId: "deepgram",
    defaultHeaders: {},
  },
  model: "nova-3",
  priceKey: "deepgram_nova3_prerecorded",
  verified: false,
};

const ORGANIZATION = "org_test";
const OPTIONS = {
  route: ROUTE,
  gateway: scriptedGateway([]).gateway,
  organizationId: ORGANIZATION,
  projectId: DEEPGRAM_PROJECT_ID,
};
const URL_REQUEST: SttRequest = {
  source: { kind: "url", url: "https://media.example.com/reel-audio.wav" },
  durationMs: DEEPGRAM_AUDIO_MS,
  language: "en",
};
const AT = "2026-10-16T09:00:00.000Z";
const PRICE_PER_MINUTE = 0.0043;

type Scripted = HttpResponse | { throws: Error } | { notConnected: string };

/** A gateway that answers each call with the next scripted answer, and records every call it receives. */
function scriptedGateway(answers: Scripted[]): { gateway: Pick<Gateway, "call">; calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  const gateway = {
    call: async (input: GatewayCall): Promise<GatewayResult> => {
      calls.push(input);
      const next = answers[calls.length - 1];
      if (next === undefined) {
        throw new Error("the scripted gateway has no answer left");
      }
      if ("throws" in next) {
        throw next.throws;
      }
      if ("notConnected" in next) {
        return { status: "not_connected", reason: next.notConnected };
      }
      return { status: "ok", response: next };
    },
  };
  return { gateway, calls };
}

async function ledgerWithReservation(): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(budgetReservationFixture);
  return ledger;
}

function meterFor(ledger: LedgerStore) {
  return {
    store: ledger,
    reservationId: budgetReservationFixture.reservationId,
    stage: "analyze_reference",
    pricePerMinuteUsd: PRICE_PER_MINUTE,
    at: AT,
  };
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to be refused");
}

function timeoutError(): Error {
  const error = new Error("the request timed out");
  error.name = "TimeoutError";
  return error;
}

function bodyText(body: string | Uint8Array | undefined): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

function queryOf(path: string | undefined): URLSearchParams {
  return new URLSearchParams((path ?? "").split("?")[1] ?? "");
}

describe("the request sent through the gateway", () => {
  it("POSTs the transcription and GETs the bill through the gateway, with the route's model and no key", async () => {
    const { gateway, calls } = scriptedGateway([listenOk(), billOk()]);
    const stt = deepgramSpeechToText({ ...OPTIONS, gateway });
    const result = await stt.transcribe(URL_REQUEST, "stt:key");
    assert.equal(result.words.length, DEEPGRAM_WORDS.length);

    const [listen, lookup] = calls;
    assert.equal(listen?.provider, "deepgram");
    assert.equal(listen?.organizationId, ORGANIZATION);
    assert.equal(listen?.method, "POST");
    assert.match(listen?.path ?? "", /^\/v1\/listen\?/);
    const query = queryOf(listen?.path);
    assert.equal(query.get("model"), "nova-3", "the model is the route's");
    assert.equal(query.get("smart_format"), "true");
    assert.equal(query.get("language"), "en");
    assert.deepEqual(JSON.parse(bodyText(listen?.body)), { url: "https://media.example.com/reel-audio.wav" });
    assert.equal(listen?.headers?.["Content-Type"], "application/json");

    assert.equal(lookup?.method, "GET");
    assert.equal(lookup?.path, `/v1/projects/${DEEPGRAM_PROJECT_ID}/requests/${DEEPGRAM_REQUEST_ID}`);
    assert.equal(lookup?.body, undefined);

    for (const call of calls) {
      for (const name of Object.keys(call.headers ?? {})) {
        assert.doesNotMatch(name, /authoriz|api-?key|token/i, "the gateway attaches the key, not the adapter");
      }
    }
  });

  it("sends raw bytes as application/octet-stream, the documented form, unchanged", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
    const { gateway, calls } = scriptedGateway([listenOk(), billOk()]);
    await deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe(
      { source: { kind: "bytes", bytes }, durationMs: DEEPGRAM_AUDIO_MS, language: "en" },
      "stt:key",
    );
    assert.equal(calls[0]?.headers?.["Content-Type"], "application/octet-stream");
    assert.deepEqual(Array.from(calls[0]?.body as Uint8Array), Array.from(bytes));
  });

  it("sends the primary language subtag, so en-US is asked as en", async () => {
    const { gateway, calls } = scriptedGateway([listenOk(), billOk()]);
    await deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe({ ...URL_REQUEST, language: "en-US" }, "stt:key");
    assert.equal(queryOf(calls[0]?.path).get("language"), "en");
  });

  it("refuses a route that is not Deepgram's, a model id that is not valid, or a project id that is not valid, and builds nothing", () => {
    assert.throws(
      () => deepgramSpeechToText({ ...OPTIONS, route: { ...ROUTE, provider: { ...ROUTE.provider, id: "openrouter" } } }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
    assert.throws(
      () => deepgramSpeechToText({ ...OPTIONS, route: { ...ROUTE, model: "nova 3/../x" } }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
    assert.throws(
      () => deepgramSpeechToText({ ...OPTIONS, projectId: "project/../keys" }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
  });

  it("deepgramForRoute gives the adapter for a Deepgram route, and null for a route to any other provider", () => {
    const deps = { gateway: scriptedGateway([]).gateway, organizationId: ORGANIZATION, projectId: DEEPGRAM_PROJECT_ID };
    assert.equal(deepgramForRoute(ROUTE, deps)?.provider, "deepgram");
    assert.equal(deepgramForRoute({ ...ROUTE, provider: { ...ROUTE.provider, id: "openrouter" } }, deps), null);
  });

  it("refuses a URL that is not https, or that carries credentials, before anything is sent, as a refusal before any work", async () => {
    for (const url of ["http://media.example.com/a.wav", "https://user:secret@media.example.com/a.wav", "not a url"]) {
      const { gateway, calls } = scriptedGateway([]);
      const stt = deepgramSpeechToText({ ...OPTIONS, gateway });
      const error = await rejection(stt.transcribe({ ...URL_REQUEST, source: { kind: "url", url } }, "stt:key"));
      assert.ok(error instanceof SttCallError, url);
      assert.equal(error.refusedBeforeWork, true, url);
      assert.equal(calls.length, 0, `nothing is sent for ${url}`);
    }
  });

  it("refuses an empty audio file and a language tag it cannot send, before anything is sent", async () => {
    const { gateway, calls } = scriptedGateway([]);
    const stt = deepgramSpeechToText({ ...OPTIONS, gateway });
    const empty = await rejection(
      stt.transcribe({ source: { kind: "bytes", bytes: new Uint8Array(0) }, durationMs: DEEPGRAM_AUDIO_MS, language: "en" }, "k"),
    );
    const badLanguage = await rejection(stt.transcribe({ ...URL_REQUEST, language: "e1" }, "k"));
    for (const refused of [empty, badLanguage]) {
      assert.ok(refused instanceof SttCallError);
      assert.equal(refused.providerKind, "invalid_input", "the request is invalid, so the vendor is not asked");
      assert.equal(refused.refusedBeforeWork, true);
    }
    assert.equal(calls.length, 0);
  });

  it("an unconnected gateway sends nothing: the refusal says NOT_CONNECTED and is refused before any work", async () => {
    const { gateway } = scriptedGateway([{ notConnected: "no Deepgram key is connected for this workspace" }]);
    const error = await rejection(deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe(URL_REQUEST, "k"));
    assert.ok(error instanceof SttCallError);
    assert.match(error.message, /NOT_CONNECTED/);
    assert.equal(error.refusedBeforeWork, true);
  });
});

describe("the transcript is untrusted until it passes the transcript validation", () => {
  it("a recorded transcript becomes validated words, in integer milliseconds, with the requested language", async () => {
    const { gateway } = scriptedGateway([listenOk(), billOk()]);
    const result = await deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe(URL_REQUEST, "k");
    assert.equal(result.language, "en");
    assert.deepEqual(result.words[0], { wordId: "w0001", text: "your", startMs: 120, endMs: 380, confidence: 0.98 });
    assert.equal(result.words[6]?.endMs, 2410);
    assert.equal(result.billedUsd, roundUsd(DEEPGRAM_BILL_USD));
  });

  it("refuses an answer the transcript validation rejects, reads no bill, and leaves the call held", async () => {
    const outOfOrder = listenOk({
      words: [
        { ...DEEPGRAM_WORDS[0]!, start: 0.5, end: 0.8 },
        { ...DEEPGRAM_WORDS[1]!, start: 0.2, end: 0.7 },
      ],
    });
    const { gateway, calls } = scriptedGateway([outOfOrder, billOk()]);
    const error = await rejection(deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe(URL_REQUEST, "k"));
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, false);
    assert.match(error.message, /starts before the word before it/);
    assert.equal(calls.length, 1, "no bill is read for a transcript that is refused");

    const ledger = await ledgerWithReservation();
    const { gateway: again } = scriptedGateway([outOfOrder, billOk()]);
    await rejection(transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway: again }), URL_REQUEST, meterFor(ledger)));
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, undefined, "an answer the vendor sent may have been billed, so the hold stays");
  });

  it("refuses an answer whose audio is longer than the audio asked about, beyond the tolerance", async () => {
    const { gateway } = scriptedGateway([listenOk({ duration: 9 })]);
    const error = await rejection(deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe(URL_REQUEST, "k"));
    assert.match(error.message, /more than the 2600 ms requested/);
  });

  it("refuses an answer with no usable shape, one that is not JSON, and one over the byte cap", async () => {
    const cases: Array<{ answer: HttpResponse; pattern: RegExp }> = [
      { answer: jsonResponse(200, { results: {} }), pattern: /no usable shape/ },
      { answer: { status: 200, headers: {}, body: new TextEncoder().encode("<html>") }, pattern: /not JSON/ },
      {
        answer: { status: 200, headers: {}, body: new Uint8Array(mediaConfig.speechToText.maxResponseBytes + 1) },
        pattern: /larger than/,
      },
    ];
    for (const { answer, pattern } of cases) {
      const { gateway } = scriptedGateway([answer]);
      const error = await rejection(deepgramSpeechToText({ ...OPTIONS, gateway }).transcribe(URL_REQUEST, "k"));
      assert.equal(error.kind, "provider");
      assert.match(error.message, pattern);
    }
  });
});

describe("the bill settles the call through the ledger (contract v6)", () => {
  it("with a bill, the call settles to the bill, rounded to the ledger's four decimals, and the hold is released to it", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([listenOk(), billOk()]);
    const outcome = await transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway }), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.estimateUsd, 0.0002, "the estimate is the list price for the audio");
    assert.equal(outcome.actualUsd, roundUsd(DEEPGRAM_BILL_USD), "the actual is the bill, never the estimate");
    assert.equal(outcome.settled, true);
    assert.equal(outcome.billNote, undefined);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, "billed");
    assert.equal(entry?.actualUsd, 0.0002);
    assert.equal(outcome.result.words.length, DEEPGRAM_WORDS.length);
  });

  it("a failed bill lookup leaves the call unsettled: the transcript is kept, the hold stays, and nothing is booked as the actual", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([listenOk(), refusal(500)]);
    const outcome = await transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway }), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.result.words.length, DEEPGRAM_WORDS.length, "the transcript is still returned");
    assert.equal(outcome.settled, false);
    assert.equal(outcome.actualUsd, null);
    assert.match(outcome.billNote ?? "", /HTTP 500/);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, undefined);
    assert.equal(entry?.actualUsd, undefined, "the estimate is never written as the actual");
    assert.equal(entry?.reservedUsd, outcome.estimateUsd, "the call holds its estimate");
  });

  it("a bill lookup that times out leaves the call unsettled", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([listenOk(), { throws: timeoutError() }]);
    const outcome = await transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway }), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.settled, false);
    assert.match(outcome.billNote ?? "", /did not answer/);
  });

  it("a bill with no usable amount, or one for another request, leaves the call unsettled", async () => {
    const unusable = scriptedGateway([listenOk(), jsonResponse(200, billAnswer({ usd: "0.0002" }))]);
    const unusableOutcome = await transcribeMetered(
      deepgramSpeechToText({ ...OPTIONS, gateway: unusable.gateway }),
      URL_REQUEST,
      meterFor(await ledgerWithReservation()),
    );
    assert.equal(unusableOutcome.settled, false);
    assert.match(unusableOutcome.billNote ?? "", /no usable usd amount/);

    const other = scriptedGateway([listenOk(), billOk({ requestId: "9a9a9a9a-0000-4000-8000-000000000000" })]);
    const otherOutcome = await transcribeMetered(
      deepgramSpeechToText({ ...OPTIONS, gateway: other.gateway }),
      URL_REQUEST,
      meterFor(await ledgerWithReservation()),
    );
    assert.equal(otherOutcome.settled, false);
    assert.match(otherOutcome.billNote ?? "", /another request/);
  });

  it("a transcript with no request id has no bill to read, so no lookup is made and the call stays unsettled", async () => {
    const { gateway, calls } = scriptedGateway([listenOk({ requestId: null })]);
    const outcome = await transcribeMetered(
      deepgramSpeechToText({ ...OPTIONS, gateway }),
      URL_REQUEST,
      meterFor(await ledgerWithReservation()),
    );
    assert.equal(calls.length, 1);
    assert.equal(outcome.settled, false);
    assert.match(outcome.billNote ?? "", /no usable request id/);
  });
});

describe("refusals and failures follow the router's classification (Bible 10.4, contract v6)", () => {
  const refusals: Array<{ status: 400 | 401 | 403; kind: string }> = [
    { status: 400, kind: "invalid_input" },
    { status: 401, kind: "unknown" },
    { status: 403, kind: "unknown" },
  ];

  for (const { status, kind } of refusals) {
    it(`a ${status} refuses the call before any work: it is settled as confirmed absent, and the next attempt takes a new key`, async () => {
      const ledger = await ledgerWithReservation();
      const { gateway, calls } = scriptedGateway([refusal(status), listenOk(), billOk()]);
      const stt = deepgramSpeechToText({ ...OPTIONS, gateway });
      const base = sttIdempotencyKey(stt, URL_REQUEST);

      const error = await rejection(transcribeMetered(stt, URL_REQUEST, meterFor(ledger)));
      assert.ok(error instanceof SttCallError);
      assert.equal(error.providerKind, kind);
      assert.equal(error.retryable, false);
      assert.equal(error.refusedBeforeWork, true);
      const [refused] = await ledger.listEntries(budgetReservationFixture.reservationId);
      assert.equal(refused?.settlement, "confirmed_absent");
      assert.equal(refused?.actualUsd, 0, "a refused call costs nothing: the hold is released");

      const outcome = await transcribeMetered(stt, URL_REQUEST, meterFor(ledger));
      assert.equal(outcome.idempotencyKey, attemptKey(base, 2));
      assert.equal(outcome.actualUsd, 0.0002);
      assert.equal(calls.filter((call) => call.method === "POST").length, 2);
    });
  }

  it("a policy-like 400 is a content refusal, still before any work, and is settled as confirmed absent", async () => {
    const ledger = await ledgerWithReservation();
    const policy = jsonResponse(400, { err_code: "Bad Request", err_msg: "Content policy violation: the audio was refused." });
    const { gateway } = scriptedGateway([policy]);
    const error = await rejection(transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway }), URL_REQUEST, meterFor(ledger)));
    assert.ok(error instanceof SttCallError);
    assert.equal(error.providerKind, "content_policy");
    assert.equal(error.refusedBeforeWork, true);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, "confirmed_absent");
  });

  const holds: Array<{ status: 404 | 408 | 429 | 500 | 503; kind: string; retryable: boolean }> = [
    { status: 404, kind: "unknown", retryable: false },
    { status: 408, kind: "timeout", retryable: true },
    { status: 429, kind: "rate_limit", retryable: true },
    { status: 500, kind: "server", retryable: true },
    { status: 503, kind: "server", retryable: true },
  ];

  for (const { status, kind, retryable } of holds) {
    it(`a ${status} keeps the hold: the vendor may have billed it, so nothing is confirmed absent and the key is not sent again`, async () => {
      const ledger = await ledgerWithReservation();
      const { gateway, calls } = scriptedGateway([refusal(status)]);
      const stt = deepgramSpeechToText({ ...OPTIONS, gateway });
      const error = await rejection(transcribeMetered(stt, URL_REQUEST, meterFor(ledger)));
      assert.ok(error instanceof SttCallError);
      assert.equal(error.providerKind, kind);
      assert.equal(error.retryable, retryable);
      assert.equal(error.refusedBeforeWork, false);
      const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
      assert.equal(entry?.settlement, undefined);

      const again = await rejection(transcribeMetered(stt, URL_REQUEST, meterFor(ledger)));
      assert.equal(again.kind, "conflict", "the unsettled key is refused as a repeat, not sent again");
      assert.equal(calls.length, 1);
    });
  }

  it("a timeout at the transport keeps the hold, as a retryable timeout", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([{ throws: timeoutError() }]);
    const error = await rejection(transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway }), URL_REQUEST, meterFor(ledger)));
    assert.ok(error instanceof SttCallError);
    assert.equal(error.providerKind, "timeout");
    assert.equal(error.refusedBeforeWork, false);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, undefined);
  });

  it("a network failure at the transport keeps the hold, as a retryable server error", async () => {
    const ledger = await ledgerWithReservation();
    const reset = Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });
    const { gateway } = scriptedGateway([{ throws: reset }]);
    const error = await rejection(transcribeMetered(deepgramSpeechToText({ ...OPTIONS, gateway }), URL_REQUEST, meterFor(ledger)));
    assert.ok(error instanceof SttCallError);
    assert.equal(error.providerKind, "server");
    assert.equal(error.retryable, true);
    assert.equal(error.refusedBeforeWork, false);
  });

  it("pricePerMinuteOf reads the route's list price, and is null for a route with no price key", () => {
    assert.equal(pricePerMinuteOf(ROUTE), PRICE_PER_MINUTE);
    assert.equal(pricePerMinuteOf({ ...ROUTE, priceKey: null }), null);
  });
});
