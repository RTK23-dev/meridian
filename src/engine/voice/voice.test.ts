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
import { gatewayFor, json, mp3Bytes, raw, routesWith, scripted } from "../assets/test/recorded.ts";
import { routes } from "../config/routes.ts";
import { budgetReservationSchema } from "../contracts/index.ts";
import { productionRequestFixture, voiceKitFixture } from "../contracts/fixtures/index.ts";
import type { ProductionRequest, ScriptBeat } from "../contracts/request.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import { deps, REQUEST_ID, RESERVATION_ID, NOW } from "../claude/test/helpers.ts";
import type { MediaFunctions } from "../media/index.ts";
import { recordedSpeechToText, type RecordedSttFixture } from "../media/stt.ts";
import type { SpeechToTextConnection } from "../media/stt-connection.ts";
import { runVoice, type VoicePorts, type VoiceRun } from "./voice.ts";
import { wordTokens } from "../analyze/copy.ts";

const ORG = "org_1";
const SPEECH_PATH = "POST /api/v1/audio/speech";
const CHAT_PATH = "POST /api/v1/chat/completions";
const TTS_MODEL = "test/eleven-v4";

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
 * The stage's ports on recorded answers. `takes` are the lengths of the speech answers in order (one per speak). `chat` is the
 * tightener's answer, or none. `stt` is the recorded speech-to-text, or null for not connected.
 */
async function harness(options: {
  takes: number[];
  chat?: unknown;
  stt?: RecordedSttFixture | null;
  speechModel?: string | null;
  loudness?: number | null;
}): Promise<Harness> {
  const store = memoryMediaStore();
  const speechReplies = options.takes.map((durationMs, position) =>
    raw(200, take(durationMs, position), { "content-type": "audio/mpeg" }),
  );
  const replies: Record<string, unknown> = { [SPEECH_PATH]: speechReplies };
  if (options.chat !== undefined) replies[CHAT_PATH] = chatReply(options.chat);
  const script = scripted(replies as Parameters<typeof scripted>[0]);
  const table = routesWith(
    "tts",
    [
      {
        provider: "openrouter",
        model: options.speechModel === undefined ? TTS_MODEL : options.speechModel,
        priceKey: "eleven_v4",
        verified: false,
      },
    ],
    routes.table,
  );
  const gateway = gatewayFor(script.transport, { routes: table });
  const store2 = await ledger();
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
      return {
        requests: script.requests
          .filter((item) => item.url.endsWith("/audio/speech"))
          .map((item) => ({ body: String(item.body) })),
      };
    },
    get chat() {
      return {
        requests: script.requests.filter((item) => item.url.endsWith("/chat/completions")).length,
      };
    },
    stt,
    media: store,
    probed,
    ledger: store2,
  };
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
      JSON.parse(h.speech.requests[0]?.body ?? "{}").input,
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
      (item) => JSON.parse(item.body) as { input: string; speed?: number },
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
});
