// The Deepgram adapter against recorded answers (synthetic, see test/deepgram-fixtures.ts). No call is made: a scripted gateway
// returns each recorded answer in order, answers GET /v1/projects from its own script, and records every request, so the tests check
// what would have been sent, what is stored, and how each refusal or failure is settled through the ledger.

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
  projectsOk,
  refusal,
} from "./test/deepgram-fixtures.ts";
import { pricePerMinuteOf } from "./stt-connection.ts";
import { deepgramBillReader, deepgramForRoute, deepgramProjects, deepgramSpeechToText, type DeepgramOptions } from "./stt-deepgram.ts";
import { attemptKey, SttCallError, sttIdempotencyKey, transcribeMetered, type SttRequest } from "./stt.ts";
import { mediaConfig } from "./config.ts";

const ROUTE: ResolvedRoute = {
  capability: "stt",
  provider: {
    id: "deepgram",
    baseUrl: "https://deepgram.test",
    // The gateway's provider entry carries the Token scheme (providers.ts). The adapter never reads the auth spec.
    auth: { kind: "api_key", header: "Authorization", scheme: "Token" },
    credentialId: "deepgram",
    defaultHeaders: {},
  },
  model: "nova-3",
  priceKey: "deepgram_nova3_prerecorded",
  verified: false,
};

const ORGANIZATION = "org_test";
const URL_REQUEST: SttRequest = {
  source: { kind: "url", url: "https://media.example.com/reel-audio.wav" },
  durationMs: DEEPGRAM_AUDIO_MS,
  language: "en",
  organizationId: ORGANIZATION,
};
const AT = "2026-10-16T09:00:00.000Z";
const PRICE_PER_MINUTE = 0.0043;

type Scripted = HttpResponse | { throws: Error } | { notConnected: string };

function answerOf(next: Scripted): GatewayResult {
  if ("throws" in next) {
    throw next.throws;
  }
  if ("notConnected" in next) {
    return { status: "not_connected", reason: next.notConnected };
  }
  return { status: "ok", response: next };
}

/**
 * A gateway that answers each transcription and bill call with the next scripted answer, answers GET /v1/projects from `projects`, and
 * records every call it receives.
 */
function scriptedGateway(
  answers: Scripted[],
  projects: Scripted = projectsOk(),
): { gateway: Pick<Gateway, "call">; calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  let scripted = 0;
  const gateway = {
    call: async (input: GatewayCall): Promise<GatewayResult> => {
      calls.push(input);
      if (input.method === "GET" && input.path === "/v1/projects") {
        return answerOf(projects);
      }
      const next = answers[scripted];
      scripted += 1;
      if (next === undefined) {
        throw new Error("the scripted gateway has no answer left");
      }
      return answerOf(next);
    },
  };
  return { gateway, calls };
}

/** The options of one adapter over one gateway, with the real project lookup over the same gateway. */
function optionsWith(gateway: Pick<Gateway, "call">): DeepgramOptions {
  return { route: ROUTE, gateway, projects: deepgramProjects(gateway) };
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

/** The bill lookups the gateway received (GET /v1/projects/.../requests/...). */
function billLookups(calls: readonly GatewayCall[]): GatewayCall[] {
  return calls.filter((call) => call.method === "GET" && (call.path ?? "").startsWith("/v1/projects/"));
}

describe("the request sent through the gateway", () => {
  it("POSTs the transcription, lists the projects and GETs the bill through the gateway, with the route's model and no key", async () => {
    const { gateway, calls } = scriptedGateway([listenOk(), billOk()]);
    const stt = deepgramSpeechToText(optionsWith(gateway));
    const result = await stt.transcribe(URL_REQUEST, "stt:key");
    assert.equal(result.words.length, DEEPGRAM_WORDS.length);

    const listen = calls.find((call) => call.method === "POST");
    assert.equal(listen?.provider, "deepgram");
    assert.equal(listen?.organizationId, ORGANIZATION);
    assert.match(listen?.path ?? "", /^\/v1\/listen\?/);
    const query = queryOf(listen?.path);
    assert.equal(query.get("model"), "nova-3", "the model is the route's");
    assert.equal(query.get("smart_format"), "true");
    assert.equal(query.get("language"), "en");
    assert.deepEqual(JSON.parse(bodyText(listen?.body)), { url: "https://media.example.com/reel-audio.wav" });
    assert.equal(listen?.headers?.["Content-Type"], "application/json");

    const projects = calls.find((call) => call.path === "/v1/projects");
    assert.equal(projects?.method, "GET");
    assert.equal(projects?.organizationId, ORGANIZATION, "the project list is the workspace's own");

    const [lookup] = billLookups(calls);
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
    await deepgramSpeechToText(optionsWith(gateway)).transcribe(
      { source: { kind: "bytes", bytes }, durationMs: DEEPGRAM_AUDIO_MS, language: "en", organizationId: ORGANIZATION },
      "stt:key",
    );
    const listen = calls.find((call) => call.method === "POST");
    assert.equal(listen?.headers?.["Content-Type"], "application/octet-stream");
    assert.deepEqual(Array.from(listen?.body as Uint8Array), Array.from(bytes));
  });

  it("sends the primary language subtag, so en-US is asked as en", async () => {
    const { gateway, calls } = scriptedGateway([listenOk(), billOk()]);
    await deepgramSpeechToText(optionsWith(gateway)).transcribe({ ...URL_REQUEST, language: "en-US" }, "stt:key");
    assert.equal(queryOf(calls[0]?.path).get("language"), "en");
  });

  it("with no language (a brief's reference), asks the vendor to detect it, and the result names the language detected", async () => {
    const { gateway, calls } = scriptedGateway([listenOk({ detectedLanguage: "de" }), billOk()]);
    const result = await deepgramSpeechToText(optionsWith(gateway)).transcribe({ ...URL_REQUEST, language: null }, "stt:key");
    const query = queryOf(calls[0]?.path);
    assert.equal(query.get("detect_language"), "true", "detection is on (Deepgram's detect_language, not verified live)");
    assert.equal(query.has("language"), false, "no language is sent when the vendor detects it");
    assert.equal(result.language, "de", "the result's language is the one detected");
  });

  it("with detection asked, an answer that names no language is an invalid answer, never a guessed language", async () => {
    const { gateway } = scriptedGateway([listenOk(), billOk()]);
    const error = await rejection(deepgramSpeechToText(optionsWith(gateway)).transcribe({ ...URL_REQUEST, language: null }, "stt:key"));
    assert.match(error.message, /detect/);
  });

  it("refuses a route that is not Deepgram's, or a model id that is not valid, and builds nothing", () => {
    const gateway = scriptedGateway([]).gateway;
    assert.throws(
      () => deepgramSpeechToText({ route: { ...ROUTE, provider: { ...ROUTE.provider, id: "openrouter" } }, gateway, projects: deepgramProjects(gateway) }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
    assert.throws(
      () => deepgramSpeechToText({ route: { ...ROUTE, model: "nova 3/../x" }, gateway, projects: deepgramProjects(gateway) }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
  });

  it("deepgramForRoute gives the adapter for a Deepgram route, and null for a route to any other provider", () => {
    const gateway = scriptedGateway([]).gateway;
    const deps = { gateway, projects: deepgramProjects(gateway) };
    assert.equal(deepgramForRoute(ROUTE, deps)?.provider, "deepgram");
    assert.equal(deepgramForRoute({ ...ROUTE, provider: { ...ROUTE.provider, id: "openrouter" } }, deps), null);
  });

  it("refuses a URL that is not https, or that carries credentials, before anything is sent, as a refusal before any work", async () => {
    for (const url of ["http://media.example.com/a.wav", "https://user:secret@media.example.com/a.wav", "not a url"]) {
      const { gateway, calls } = scriptedGateway([]);
      const stt = deepgramSpeechToText(optionsWith(gateway));
      const error = await rejection(stt.transcribe({ ...URL_REQUEST, source: { kind: "url", url } }, "stt:key"));
      assert.ok(error instanceof SttCallError, url);
      assert.equal(error.refusedBeforeWork, true, url);
      assert.equal(calls.length, 0, `nothing is sent for ${url}`);
    }
  });

  it("refuses an empty audio file and a language tag it cannot send, before anything is sent", async () => {
    const { gateway, calls } = scriptedGateway([]);
    const stt = deepgramSpeechToText(optionsWith(gateway));
    const empty = await rejection(
      stt.transcribe(
        { source: { kind: "bytes", bytes: new Uint8Array(0) }, durationMs: DEEPGRAM_AUDIO_MS, language: "en", organizationId: ORGANIZATION },
        "k",
      ),
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
    const error = await rejection(deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k"));
    assert.ok(error instanceof SttCallError);
    assert.match(error.message, /NOT_CONNECTED/);
    assert.equal(error.refusedBeforeWork, true);
  });

  it("a request with no workspace in scope is not sent, because no key can be chosen for it", async () => {
    const { gateway, calls } = scriptedGateway([listenOk()]);
    const error = await rejection(
      deepgramSpeechToText(optionsWith(gateway)).transcribe({ ...URL_REQUEST, organizationId: null }, "k"),
    );
    assert.ok(error instanceof SttCallError);
    assert.equal(error.refusedBeforeWork, true);
    assert.equal(calls.length, 0);
  });
});

describe("the Deepgram project, from GET /v1/projects (UNVERIFIED LIVE)", () => {
  it("exactly one project is named, asked through the gateway for the workspace, and cached per workspace", async () => {
    const { gateway, calls } = scriptedGateway([], projectsOk([DEEPGRAM_PROJECT_ID]));
    const projects = deepgramProjects(gateway);
    const first = await projects.forWorkspace("org_a");
    const second = await projects.forWorkspace("org_a");
    assert.deepEqual(first, { status: "ready", projectId: DEEPGRAM_PROJECT_ID });
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1, "the second lookup for the same workspace is answered from the cache");
    assert.equal(calls[0]?.organizationId, "org_a");
    assert.equal(calls[0]?.path, "/v1/projects");

    await projects.forWorkspace("org_b");
    assert.equal(calls.length, 2, "another workspace is asked for its own project");
    assert.equal(calls[1]?.organizationId, "org_b");
  });

  it("zero projects is NOT_CONNECTED with its reason, and is not cached, so the next call asks again", async () => {
    const { gateway, calls } = scriptedGateway([], projectsOk([]));
    const projects = deepgramProjects(gateway);
    const lookup = await projects.forWorkspace("org_a");
    assert.equal(lookup.status, "not_connected");
    assert.match(lookup.status === "not_connected" ? lookup.reason : "", /^NOT_CONNECTED: .*reaches no Deepgram project/);
    await projects.forWorkspace("org_a");
    assert.equal(calls.length, 2, "a failed lookup is not cached");
  });

  it("more than one project is NOT_CONNECTED: the bill cannot be attributed without a choice, so nothing is guessed", async () => {
    const { gateway } = scriptedGateway([], projectsOk(["11111111-aaaa-4bbb-8ccc-000000000001", "22222222-aaaa-4bbb-8ccc-000000000002"]));
    const lookup = await deepgramProjects(gateway).forWorkspace("org_a");
    assert.equal(lookup.status, "not_connected");
    assert.match(lookup.status === "not_connected" ? lookup.reason : "", /reaches 2 Deepgram projects/);
  });

  it("the same project listed twice is one project", async () => {
    const { gateway } = scriptedGateway([], projectsOk([DEEPGRAM_PROJECT_ID, DEEPGRAM_PROJECT_ID]));
    assert.deepEqual(await deepgramProjects(gateway).forWorkspace("org_a"), { status: "ready", projectId: DEEPGRAM_PROJECT_ID });
  });

  it("a project id the adapter cannot use, or a list with no usable shape, is NOT_CONNECTED", async () => {
    const unusable = scriptedGateway([], projectsOk(["bad/../id"]));
    const bad = await deepgramProjects(unusable.gateway).forWorkspace("org_a");
    assert.equal(bad.status, "not_connected");
    assert.match(bad.status === "not_connected" ? bad.reason : "", /cannot use/);

    const shape = scriptedGateway([], jsonResponse(200, { projects: "not a list" }));
    const badShape = await deepgramProjects(shape.gateway).forWorkspace("org_a");
    assert.match(badShape.status === "not_connected" ? badShape.reason : "", /no usable shape/);
  });

  it("a failed, refused, unreachable or unreadable project list is NOT_CONNECTED and not cached", async () => {
    const cases: Array<{ projects: Scripted; pattern: RegExp }> = [
      { projects: refusal(500), pattern: /HTTP 500/ },
      { projects: refusal(401), pattern: /HTTP 401/ },
      { projects: { throws: timeoutError() }, pattern: /did not answer/ },
      { projects: { notConnected: "no Deepgram key is connected for this workspace" }, pattern: /not connected/ },
      { projects: { status: 200, headers: {}, body: new TextEncoder().encode("<html>") }, pattern: /not JSON/ },
    ];
    for (const { projects, pattern } of cases) {
      const { gateway, calls } = scriptedGateway([], projects);
      const lookup = await deepgramProjects(gateway).forWorkspace("org_a");
      assert.equal(lookup.status, "not_connected", pattern.source);
      assert.match(lookup.status === "not_connected" ? lookup.reason : "", pattern);
      assert.equal(calls.length, 1);
    }
  });

  it("no workspace in scope names no project and sends nothing", async () => {
    const { gateway, calls } = scriptedGateway([], projectsOk());
    const lookup = await deepgramProjects(gateway).forWorkspace(null);
    assert.equal(lookup.status, "not_connected");
    assert.match(lookup.status === "not_connected" ? lookup.reason : "", /no workspace is in scope/);
    assert.equal(calls.length, 0);
  });

  it("with two projects the transcript is kept, the call stays held, and no bill is requested", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway, calls } = scriptedGateway(
      [listenOk()],
      projectsOk(["11111111-aaaa-4bbb-8ccc-000000000001", "22222222-aaaa-4bbb-8ccc-000000000002"]),
    );
    const outcome = await transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.result.words.length, DEEPGRAM_WORDS.length);
    assert.equal(outcome.settled, false);
    assert.equal(outcome.actualUsd, null);
    assert.match(outcome.billNote ?? "", /^NOT_CONNECTED: /);
    assert.equal(billLookups(calls).length, 0, "the bill is not requested without a project");
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, undefined);
  });
});

describe("the transcript is untrusted until it passes the transcript validation", () => {
  it("a recorded transcript becomes validated words, in integer milliseconds, with the requested language", async () => {
    const { gateway } = scriptedGateway([listenOk(), billOk()]);
    const result = await deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k");
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
    const error = await rejection(deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k"));
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, false);
    assert.match(error.message, /starts before the word before it/);
    assert.equal(calls.length, 1, "no project or bill is read for a transcript that is refused");

    const ledger = await ledgerWithReservation();
    const again = scriptedGateway([outOfOrder, billOk()]);
    await rejection(transcribeMetered(deepgramSpeechToText(optionsWith(again.gateway)), URL_REQUEST, meterFor(ledger)));
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, undefined, "an answer the vendor sent may have been billed, so the hold stays");
  });

  it("refuses an answer whose audio is longer than the audio asked about, beyond the tolerance", async () => {
    const { gateway } = scriptedGateway([listenOk({ duration: 9 })]);
    const error = await rejection(deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k"));
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
      const error = await rejection(deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k"));
      assert.equal(error.kind, "provider");
      assert.match(error.message, pattern);
    }
  });
});

describe("the bill settles the call through the ledger (contract v6)", () => {
  it("with a bill, the call settles to the bill, rounded to the ledger's four decimals, and the hold is released to it", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway, calls } = scriptedGateway([listenOk(), billOk()]);
    const outcome = await transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.estimateUsd, 0.0002, "the estimate is the list price for the audio");
    assert.equal(outcome.actualUsd, roundUsd(DEEPGRAM_BILL_USD), "the actual is the bill, never the estimate");
    assert.equal(outcome.settled, true);
    assert.equal(outcome.billNote, undefined);
    assert.equal(billLookups(calls)[0]?.path, `/v1/projects/${DEEPGRAM_PROJECT_ID}/requests/${DEEPGRAM_REQUEST_ID}`);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, "billed");
    assert.equal(entry?.actualUsd, 0.0002);
    assert.equal(outcome.result.words.length, DEEPGRAM_WORDS.length);
  });

  it("a failed bill lookup leaves the call unsettled: the transcript is kept, the hold stays, and nothing is booked as the actual", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([listenOk(), refusal(500)]);
    const outcome = await transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger));
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
    const outcome = await transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.settled, false);
    assert.match(outcome.billNote ?? "", /did not answer/);
  });

  it("a bill with no usable amount, or one for another request, leaves the call unsettled", async () => {
    const unusable = scriptedGateway([listenOk(), jsonResponse(200, billAnswer({ usd: "0.0002" }))]);
    const unusableOutcome = await transcribeMetered(
      deepgramSpeechToText(optionsWith(unusable.gateway)),
      URL_REQUEST,
      meterFor(await ledgerWithReservation()),
    );
    assert.equal(unusableOutcome.settled, false);
    assert.match(unusableOutcome.billNote ?? "", /no usable usd amount/);

    const other = scriptedGateway([listenOk(), billOk({ requestId: "9a9a9a9a-0000-4000-8000-000000000000" })]);
    const otherOutcome = await transcribeMetered(
      deepgramSpeechToText(optionsWith(other.gateway)),
      URL_REQUEST,
      meterFor(await ledgerWithReservation()),
    );
    assert.equal(otherOutcome.settled, false);
    assert.match(otherOutcome.billNote ?? "", /another request/);
  });

  it("a transcript with no request id has no bill to read, so no lookup is made and the call stays unsettled", async () => {
    const { gateway, calls } = scriptedGateway([listenOk({ requestId: null })]);
    const outcome = await transcribeMetered(
      deepgramSpeechToText(optionsWith(gateway)),
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
      const stt = deepgramSpeechToText(optionsWith(gateway));
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
    const error = await rejection(transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger)));
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
      const stt = deepgramSpeechToText(optionsWith(gateway));
      const error = await rejection(transcribeMetered(stt, URL_REQUEST, meterFor(ledger)));
      assert.ok(error instanceof SttCallError);
      assert.equal(error.providerKind, kind);
      assert.equal(error.retryable, retryable);
      assert.equal(error.refusedBeforeWork, false);
      const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
      assert.equal(entry?.settlement, undefined);

      const again = await rejection(transcribeMetered(stt, URL_REQUEST, meterFor(ledger)));
      assert.equal(again.kind, "conflict", "the unsettled key is refused as a repeat, not sent again");
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    });
  }

  it("a timeout at the transport keeps the hold, as a retryable timeout", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([{ throws: timeoutError() }]);
    const error = await rejection(transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger)));
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
    const error = await rejection(transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger)));
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

describe("the request id is the call's providerRef, and the bill reader of a held call (contract v9)", () => {
  it("the transcript names its request id as the providerRef", async () => {
    const { gateway } = scriptedGateway([listenOk(), billOk()]);
    const result = await deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k");
    assert.equal(result.providerRef, DEEPGRAM_REQUEST_ID);
  });

  it("a transcript with no request id names no providerRef", async () => {
    const { gateway } = scriptedGateway([listenOk({ requestId: null }), billOk()]);
    const result = await deepgramSpeechToText(optionsWith(gateway)).transcribe(URL_REQUEST, "k");
    assert.equal(result.providerRef, undefined);
  });

  it("a metered call that is billed settles to the bill and keeps its request id on the entry", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway([listenOk(), billOk()]);
    const outcome = await transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.settled, true);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, "billed");
    assert.equal(entry?.providerRef, DEEPGRAM_REQUEST_ID);
  });

  it("a metered call with no bill stays held, and its request id is recorded for the reconciler", async () => {
    const ledger = await ledgerWithReservation();
    const { gateway } = scriptedGateway(
      [listenOk()],
      projectsOk(["11111111-aaaa-4bbb-8ccc-000000000001", "22222222-aaaa-4bbb-8ccc-000000000002"]),
    );
    const outcome = await transcribeMetered(deepgramSpeechToText(optionsWith(gateway)), URL_REQUEST, meterFor(ledger));
    assert.equal(outcome.settled, false);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.settlement, undefined);
    assert.equal(entry?.providerRef, DEEPGRAM_REQUEST_ID);
  });

  it("the bill reader reads a call's bill from its request id, in the workspace's project", async () => {
    const { gateway, calls } = scriptedGateway([billOk()]);
    const read = await deepgramBillReader(optionsWith(gateway))({ organizationId: ORGANIZATION, providerRef: DEEPGRAM_REQUEST_ID });
    assert.deepEqual(read, { status: "billed", usd: roundUsd(DEEPGRAM_BILL_USD) });
    const lookups = calls.filter((call) => call.method === "GET" && (call.path ?? "").includes(`/requests/${DEEPGRAM_REQUEST_ID}`));
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0]?.organizationId, ORGANIZATION);
  });

  it("the bill reader is unavailable, with its reason, when the lookup refuses or no workspace is in scope", async () => {
    const refused = scriptedGateway([refusal(404)]);
    const missed = await deepgramBillReader(optionsWith(refused.gateway))({ organizationId: ORGANIZATION, providerRef: DEEPGRAM_REQUEST_ID });
    assert.equal(missed.status, "unavailable");
    assert.match(missed.status === "unavailable" ? missed.reason : "", /HTTP 404/);

    const unscoped = scriptedGateway([billOk()]);
    const noWorkspace = await deepgramBillReader(optionsWith(unscoped.gateway))({ organizationId: "", providerRef: DEEPGRAM_REQUEST_ID });
    assert.equal(noWorkspace.status, "unavailable");
    assert.equal(unscoped.calls.length, 0, "no bill is requested without a workspace");
  });
});
