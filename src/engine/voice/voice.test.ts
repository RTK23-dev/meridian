// The voice stage on recorded answers (Bible 6.3). The asset router, the speech adapter and the tightener role run for real, on
// recorded transports: the speech route answers with recorded bytes, and the chat route with a recorded answer. The take's
// length is the recorded size of its bytes (the recorded probe reads it), and its loudness is a recorded measure. The
// speech-to-text answers are synthetic and labelled so. No test calls a live API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAssetRouter, type AssetRouter } from "../assets/router.ts";
import { memoryAssetCache } from "../assets/cache.ts";
import { memoryProviderStats } from "../assets/stats.ts";
import { memoryBreakerStore } from "../assets/breaker.ts";
import { memoryBucketStore } from "../assets/buckets.ts";
import { memoryMediaStore } from "../assets/adapter.ts";
import { base64, gatewayFor, json, mp3Bytes, raw, routesWith, scripted } from "../assets/test/recorded.ts";
import { routes } from "../config/routes.ts";
import { budgetReservationSchema, EngineError } from "../contracts/index.ts";
import { productionRequestFixture, voiceKitFixture } from "../contracts/fixtures/index.ts";
import type { ProductionRequest, ScriptBeat } from "../contracts/request.ts";
import type { HttpResponse, HttpTransport } from "../gateway/types.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import { deps, REQUEST_ID, RESERVATION_ID, NOW } from "../claude/test/helpers.ts";
import type { MediaFunctions } from "../media/index.ts";
import { recordedSpeechToText, type RecordedSttFixture } from "../media/stt.ts";
import type { SpeechToTextConnection } from "../media/stt-connection.ts";
import { runVoice, type VoicePorts, type VoiceRun } from "./voice.ts";
import { wordTokens } from "../analyze/copy.ts";

const ORG = "org_1";
const CHAT_PATH = "POST /api/v1/chat/completions";
// The speech model is the kit's provider's (the fixture voice kit is fixture-tts), so the voice is spoken by that vendor's model.
const TTS_MODEL = "fixture-tts/eleven-v4";
const GENERATION_ID = "gen-voice-speech-1";
/** The bill the generation stats give for one take (USD). */
const SPEECH_BILL_USD = 0.0004;

const BEATS: ScriptBeat[] = [
  {
    beatId: "b1",
    role: "hook",
    text: "Stop scrolling: this blender crushes ice in seconds.",
    emphasis: ["scrolling"],
  },
  {
    beatId: "b2",
    role: "proof",
    text: "It costs 29 dollars and has ten speeds.",
    emphasis: ["29"],
  },
  { beatId: "b3", role: "cta", text: "Tap the link now" },
];

/** The script after the longest beat is tightened (the tightener's recorded answer below). */
const TIGHTENED_B1 = "Stop scrolling: this blender crushes ice.";

const ORIGINAL_TEXT =
  "Stop scrolling: this blender crushes ice in seconds. It costs 29 dollars and has ten speeds. Tap the link now.";
const TIGHTENED_TEXT = `${TIGHTENED_B1} It costs 29 dollars and has ten speeds. Tap the link now.`;

/** Speech-to-text words for the tightened script, every word said with a clear gap (synthetic, labelled in the fixture note). */
function spokenWords(script: string, perWord = 0.15): RecordedSttFixture["responses"][number] {
  const tokens = wordTokens(script);
  const words = tokens.map((token, index) => ({
    text: token,
    start: 0.05 + index * perWord,
    end: 0.05 + index * perWord + 0.12,
    confidence: 0.95,
  }));
  return { outcome: "ok", language: "en", words, billedUsd: null };
}

/** The fixture of the speech-to-text service, with the given answers in order. */
function sttWith(responses: RecordedSttFixture["responses"]): RecordedSttFixture {
  return {
    provider: "test-stt",
    model: "test-stt-model",
    source: "synthetic",
    recordedAt: NOW,
    responses,
  };
}

function chatReply(content: unknown) {
  return json(200, {
    id: "gen-e3-tightener-0001",
    model: "anthropic/claude-haiku-5.5",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(content) },
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, cost: 0.0003 },
  });
}

/**
 * One take: its bytes are the mp3 of the recorded size, which is the take's length in milliseconds. The take's position in the
 * recording is written into a header byte, so each take is different audio (a retake is new audio, and the speech-to-text key is
 * the audio's hash, so the same bytes would be the same call).
 */
function take(durationMs: number, position: number): Uint8Array {
  const bytes = mp3Bytes(durationMs);
  bytes[8] = position + 1;
  return bytes;
}

function request(overrides: Partial<ProductionRequest["constraints"]> = {}): ProductionRequest {
  return {
    ...productionRequestFixture,
    script: { language: "en", beats: BEATS },
    constraints: { ...productionRequestFixture.constraints, maxMs: 3000, ...overrides },
  };
}

function runFor(maxMs?: number): VoiceRun {
  return {
    organizationId: ORG,
    requestId: REQUEST_ID,
    reservationId: RESERVATION_ID,
    attempt: 1,
    subjectId: "subject_voice_1",
    request: request(maxMs === undefined ? {} : { maxMs }),
    script: { language: "en", beats: BEATS },
    voice: voiceKitFixture,
    claims: [],
  };
}

async function ledger(): Promise<LedgerStore> {
  const store = memoryLedgerStore();
  await store.createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: RESERVATION_ID,
      requestId: REQUEST_ID,
      workspaceId: ORG,
      mode: "cap",
      lines: [
        { stage: "voice", estimateUsd: 0.5 },
        { stage: "claude_roles", estimateUsd: 0.5 },
      ],
      estimateUsd: 1,
      redoAllowanceUsd: 0,
      reservedUsd: 1,
      state: "reserved",
      createdAt: NOW,
    }),
  );
  return store;
}

type Harness = {
  ports: VoicePorts;
  readonly speech: { requests: Array<{ body: string }> };
  readonly chat: { requests: number };
  stt: ReturnType<typeof recordedSpeechToText>;
  media: ReturnType<typeof memoryMediaStore>;
  probed: number[];
  ledger: LedgerStore;
};

/**
 * The speech answer of one take, as OpenRouter documents audio output: a stream of base64 chunks with the generation id and [DONE]. Its
 * bytes are the take's (the take is the audio the stream carries).
 */
function speechStreamOf(audio: Uint8Array): HttpResponse {
  const half = Math.floor(audio.byteLength / 2);
  const events = [
    `data: ${JSON.stringify({ id: GENERATION_ID, choices: [{ index: 0, delta: { audio: { data: base64(audio.subarray(0, half)) } } }] })}`,
    "",
    `data: ${JSON.stringify({ id: GENERATION_ID, choices: [{ index: 0, delta: { audio: { data: base64(audio.subarray(half)) } } }] })}`,
    "",
    "data: [DONE]",
    "",
  ];
  return raw(200, new TextEncoder().encode(events.join("\n")), { "content-type": "text/event-stream" });
}

/**
 * The stage's ports on recorded answers. `takes` are the lengths of the speech answers in order (one per speak; the last repeats). `chat`
 * is the tightener's answer, or none. `stt` is the recorded speech-to-text, or null for not connected. The speech calls and the tightener
 * share the chat completions path, so the transport tells them apart by the request: a speech call asks for audio output.
 */
async function harness(options: {
  takes: number[];
  chat?: unknown;
  stt?: RecordedSttFixture | null;
  speechModel?: string | null;
  loudness?: number | null;
  /** False: the generation stats have no bill for the speech calls, so each narration call stays held (contract v6). Default true. */
  speechBilled?: boolean;
  /** The price key of the speech target. Default eleven_v4 (per million characters). */
  speechPriceKey?: "eleven_v4" | "gemini_3_8_flash_tts";
}): Promise<Harness> {
  const store = memoryMediaStore();
  const speechAnswers: HttpResponse[] = options.takes.map((durationMs, position) => speechStreamOf(take(durationMs, position)));
  const speechRequests: Array<{ body: string }> = [];
  const chatScript = scripted(options.chat === undefined ? {} : { [CHAT_PATH]: chatReply(options.chat) });
  const table = routesWith(
    "tts",
    [
      {
        provider: "openrouter",
        model: options.speechModel === undefined ? TTS_MODEL : options.speechModel,
        priceKey: options.speechPriceKey ?? "eleven_v4",
        verified: false,
      },
    ],
    routes.table,
  );
  const store2 = await ledger();
  const transport: HttpTransport = async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.endsWith("/chat/completions") && String(request.body).includes('"modalities"')) {
      speechRequests.push({ body: String(request.body) });
      const position = Math.min(speechRequests.length - 1, speechAnswers.length - 1);
      const answer = speechAnswers[position];
      if (answer === undefined) throw new Error("no recorded speech answer is left");
      return answer;
    }
    if (request.method === "GET" && path.endsWith("/generation")) {
      // The bill of a finished take, read once after its audio is stored (contract v9). With speechBilled false the stats have none yet.
      return options.speechBilled === false ? json(404, { error: "the generation stats are not there yet" }) : json(200, { data: { id: GENERATION_ID, total_cost: SPEECH_BILL_USD } });
    }
    return chatScript.transport(request);
  };
  const gateway = gatewayFor(transport, { routes: table });
  const router: AssetRouter = createAssetRouter({
    gateway,
    ledger: store2,
    cache: memoryAssetCache(),
    stats: memoryProviderStats(),
    breakers: memoryBreakerStore(),
    buckets: memoryBucketStore(),
    media: store,
    now: () => Date.parse(NOW),
    sleep: async () => {},
  });
  const probed: number[] = [];
  const media: MediaFunctions = {
    id: "recorded:voice-takes",
    probe: async (request) => {
      if (request.source.kind !== "bytes")
        throw new Error("the voice stage probes the take's bytes");
      probed.push(request.source.bytes.byteLength);
      return {
        container: "mp3",
        videoCodec: null,
        audioCodec: "mp3",
        width: null,
        height: null,
        fps: null,
        durationMs: request.source.bytes.byteLength,
        audioPresent: true,
        bytes: request.source.bytes.byteLength,
      };
    },
    frames: async () => {
      throw new Error("voice does not read frames");
    },
    loudness: async () => ({
      integratedLufs: options.loudness === undefined ? -16.2 : options.loudness,
      truePeakDbtp: -1.5,
      loudnessRangeLu: 6,
    }),
    cuts: async () => {
      throw new Error("voice does not cut");
    },
    timeline: async () => {
      throw new Error("voice does not measure the timeline");
    },
  };
  const stt = recordedSpeechToText(options.stt ?? sttWith([]));
  const speech: SpeechToTextConnection =
    options.stt === null
      ? { status: "not_connected", reason: "NOT_CONNECTED: no speech-to-text vendor (test)" }
      : { status: "ready", stt };
  const ports: VoicePorts = {
    router,
    speech,
    sttPricePerMinuteUsd: 0.006,
    media,
    roles: deps(gateway, store2),
    loadAudio: async (uri) => {
      const object = store.objects.get(uri);
      if (!object) throw new Error(`no stored take for ${uri}`);
      return object.bytes as Uint8Array<ArrayBuffer>;
    },
  };
  return {
    ports,
    get speech() {
      return { requests: speechRequests };
    },
    get chat() {
      return { requests: chatScript.requests.length };
    },
    stt,
    media: store,
    probed,
    ledger: store2,
  };
}

/** The text a speech request asks to be spoken (the user's message, contract v9 speech request). */
function spokenOf(body: string): string {
  const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
  return parsed.messages[0]?.content ?? "";
}

describe("the voice stage on recorded answers (Bible 6.3)", () => {
  it("speaks the script, transcribes the take, measures it, and builds a track with beat spans that cover it", async () => {
    const h = await harness({ takes: [2900], stt: sttWith([spokenWords(ORIGINAL_TEXT)]) });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(
      outcome.gate.pass,
      true,
      JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)),
    );
    assert.ok(outcome.track);
    if (!outcome.track) return;
    assert.equal(outcome.track.durationMs, 2900);
    assert.equal(outcome.track.lufs, -16.2);
    assert.equal(outcome.track.voiceId, request().page.voiceId);
    assert.match(outcome.track.audioUri, /^memory:\/\/org_1\//);
    assert.equal(
      spokenOf(h.speech.requests[0]?.body ?? "{}"),
      ORIGINAL_TEXT,
      "the first speech request is the script with its pacing",
    );
    assert.equal(
      outcome.track.words.length,
      wordTokens(ORIGINAL_TEXT).length,
      "every script word is timed in the track",
    );
    const spans = outcome.track.beatSpans;
    assert.deepEqual(
      spans.map((span) => span.beatId),
      ["b1", "b2", "b3"],
    );
    assert.equal(spans[0]?.startMs, 0);
    assert.equal(spans.at(-1)?.endMs, 2900);
    for (let index = 1; index < spans.length; index++)
      assert.equal(spans[index]?.startMs, spans[index - 1]?.endMs, "no gap between beats");
  });

  it("over maxMs: paces faster twice, then the tightener shortens the longest beat, and the narration is spoken again", async () => {
    const h = await harness({
      takes: [4000, 3600, 3300, 2900],
      chat: { text: TIGHTENED_B1 },
      stt: sttWith([spokenWords(TIGHTENED_TEXT)]),
    });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(
      outcome.gate.pass,
      true,
      JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)),
    );
    const bodies = h.speech.requests.map(
      (item) => ({ ...(JSON.parse(item.body) as { speed?: number }), input: spokenOf(item.body) }),
    );
    assert.deepEqual(
      bodies.map((body) => body.speed ?? 1),
      [1, 1.1, 1.2, 1.2],
      "the normal pace, then the two faster paces, then the fastest pace again for the tightened text",
    );
    assert.equal(bodies[0]?.input, ORIGINAL_TEXT);
    assert.equal(bodies[3]?.input, TIGHTENED_TEXT, "only the longest beat changed");
    assert.equal(h.chat.requests, 1, "the tightener is called once");
    assert.equal(outcome.track?.durationMs, 2900);
    assert.match(
      outcome.track?.provider ?? "",
      /@speed=1\.2$/,
      "the track names the pace it was taken at",
    );
  });

  it("fails the length gate when the narration is still over maxMs after the faster paces and the tightening", async () => {
    const h = await harness({
      takes: [4000, 3600, 3300, 2900],
      chat: { text: "Stop scrolling: crushes ice." },
      stt: sttWith([]),
    });
    const outcome = await runVoice(runFor(2000), h.ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.ok(
      outcome.gate.checks.some((check) => check.rule === "duration_within_max" && !check.pass),
    );
    assert.equal(outcome.track, null);
    assert.equal(h.stt.calls.length, 0, "an over-length take is not transcribed");
  });

  it("retakes once when the transcript differs from the script beyond the word error rate, and passes the retake", async () => {
    const spoken = spokenWords(ORIGINAL_TEXT);
    const wrong = {
      ...spoken,
      words:
        spoken.outcome === "ok"
          ? spoken.words.map((word) =>
              word.text === "crushes" ? { ...word, text: "crush" } : word,
            )
          : [],
    };
    const h = await harness({ takes: [2900, 2900], stt: sttWith([wrong, spoken]) });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(
      outcome.gate.pass,
      true,
      JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)),
    );
    assert.equal(h.speech.requests.length, 2, "the retake is a second speech call");
    assert.equal(h.stt.calls.length, 2);
  });

  it("fails the transcript check when the retake also differs from the script", async () => {
    const spoken = spokenWords(ORIGINAL_TEXT);
    const wrong = {
      ...spoken,
      words:
        spoken.outcome === "ok"
          ? spoken.words.map((word) =>
              word.text === "crushes" ? { ...word, text: "crush" } : word,
            )
          : [],
    };
    const h = await harness({ takes: [2900, 2900], stt: sttWith([wrong, wrong]) });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.ok(
      outcome.gate.checks.some(
        (check) => check.rule === "transcript_matches_script" && !check.pass,
      ),
    );
    assert.equal(outcome.track, null);
  });

  it("refuses to start when speech-to-text is not connected, before any speech call", async () => {
    const h = await harness({ takes: [2900], stt: null });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "not_connected");
    if (outcome.status !== "not_connected") return;
    assert.match(outcome.reason, /^NOT_CONNECTED:/);
    assert.equal(h.speech.requests.length, 0, "no speech call was made");
    assert.equal(
      (await h.ledger.listEntries(RESERVATION_ID)).length,
      0,
      "nothing was written to the ledger",
    );
  });

  it("refuses to start when the speech route has no model, with the router's reason, and sends nothing", async () => {
    const h = await harness({ takes: [2900], stt: sttWith([]), speechModel: null });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "not_connected");
    if (outcome.status !== "not_connected") return;
    assert.match(outcome.reason, /^NOT_CONNECTED: the speech route is not connected: .*tts/);
    assert.equal(h.speech.requests.length, 0);
  });

  it("fails the loudness check when the take's loudness is not measurable, and stores no track", async () => {
    const h = await harness({
      takes: [2900],
      stt: sttWith([spokenWords(ORIGINAL_TEXT)]),
      loudness: null,
    });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.track, null);
    assert.ok(outcome.gate.checks.some((check) => check.rule === "lufs_measured" && !check.pass));
  });

  it("a narration whose provider reports no bill stays held: the stage stops with a conflict, and nothing is transcribed or stored", async () => {
    const h = await harness({ takes: [2900], stt: sttWith([spokenWords(ORIGINAL_TEXT)]), speechBilled: false });
    await assert.rejects(runVoice(runFor(), h.ports), (error: unknown) => {
      return error instanceof EngineError && error.kind === "conflict" && error.retryable === false && /unsettled/.test(error.message);
    });
    const rows = await h.ledger.listEntries(RESERVATION_ID);
    assert.equal(rows.filter((row) => row.stage === "voice" && row.settlement === undefined).length, 1, "the narration's hold stays on the ledger");
    assert.equal(rows.filter((row) => row.settlement !== undefined).length, 0, "no call is settled without a bill");
    assert.equal(h.stt.calls.length, 0, "no take is transcribed before the narration is settled");
    assert.equal(h.speech.requests.length, 1, "the narration is sent once; no retry follows an unsettled call");
  });

  it("no speech target is usable for the page (its only model is priced per output token, so it is not estimated): NOT_CONNECTED with the reason, and nothing is sent", async () => {
    const h = await harness({
      takes: [2900],
      stt: sttWith([spokenWords(ORIGINAL_TEXT)]),
      speechModel: "fixture-tts/gemini-3.8-flash-tts",
      speechPriceKey: "gemini_3_8_flash_tts",
    });
    const outcome = await runVoice(runFor(), h.ports);
    assert.equal(outcome.status, "not_connected");
    if (outcome.status === "not_connected") assert.match(outcome.reason, /^NOT_CONNECTED: no speech target is usable for this page/);
    assert.equal(h.speech.requests.length, 0, "nothing is sent");
  });
});
