// The OpenRouter speech adapter on recorded answers (contract v9, owner decision 2026-10-17). The request is chat completions with audio
// output, answered as a server-sent event stream. The stream's chunks are joined as bytes, and the bill is read once from the generation
// stats. Every answer here is synthetic, in the shape OpenRouter documents, and UNVERIFIED LIVE. No test calls a live API.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { EngineError } from "../../contracts/errors.ts";
import { ProviderCallError } from "../classify.ts";
import { memoryMediaStore } from "../adapter.ts";
import { assetSpec, base64, gatewayFor, json, mp3Bytes, raw, routesWith, scripted } from "../test/recorded.ts";
import { openRouterSpeechAdapter, SPEECH_SPEED_RANGE, speechFromStream, vendorOf } from "./openrouterSpeech.ts";
import { routes } from "../../config/routes.ts";

const CHAT = "POST /api/v1/chat/completions";
const STATS = "GET /api/v1/generation";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const statsWithCost = JSON.parse(readFileSync(join(FIXTURES, "openrouter-generation-stats.json"), "utf8")) as unknown;
const statsWithoutCost = JSON.parse(readFileSync(join(FIXTURES, "openrouter-generation-stats-no-cost.json"), "utf8")) as unknown;
const GENERATION = "gen-speech-1";
const STREAM_HEADERS = { "content-type": "text/event-stream" };

/**
 * A server-sent event stream of the audio, in the shape OpenRouter documents for audio output: one event per base64 chunk, a comment line
 * first, and [DONE] last. `chunkSizes` split the audio, so a chunk need not be a multiple of three bytes.
 */
function streamOf(audio: Uint8Array, options: { id?: string | null; chunkSizes?: number[]; withDone?: boolean; nullFields?: boolean } = {}): Uint8Array {
  const sizes = options.chunkSizes ?? [audio.byteLength];
  const events: string[] = [": OPENROUTER PROCESSING"];
  let offset = 0;
  for (const size of sizes) {
    const chunk = audio.subarray(offset, offset + size);
    offset += size;
    const delta: Record<string, unknown> = { audio: { data: base64(chunk), transcript: "" } };
    if (options.nullFields === true) delta.content = null;
    const event: Record<string, unknown> = {
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta }],
    };
    if (options.id !== null) event.id = options.id ?? GENERATION;
    events.push(`data: ${JSON.stringify(event)}`);
    events.push("");
  }
  if (options.withDone !== false) events.push("data: [DONE]", "");
  return new TextEncoder().encode(events.join("\n"));
}

function setup(
  replies: Parameters<typeof scripted>[0],
  options: { voice?: string | null; model?: string | null; voiceProvider?: string | null; priceKey?: "eleven_v4" | "gemini_3_8_flash_tts"; speed?: number } = {},
) {
  const voice = options.voice === undefined ? "voice_warm_01" : options.voice;
  const model = options.model === undefined ? "elevenlabs/eleven-v4" : options.model;
  const voiceProvider = options.voiceProvider === undefined ? "elevenlabs" : options.voiceProvider;
  const priceKey = options.priceKey ?? "eleven_v4";
  const script = scripted(replies);
  const table = routesWith("tts", [{ provider: "openrouter", model, priceKey, verified: false }], routes.table);
  const gateway = gatewayFor(script.transport, { routes: table });
  const route = gateway.routes("tts")[0];
  if (!route) throw new Error("no tts route");
  const media = memoryMediaStore();
  const adapter = openRouterSpeechAdapter({
    gateway,
    organizationId: "org_1",
    workspaceId: "org_1",
    route,
    media,
    voice,
    voiceProvider,
    ...(options.speed === undefined ? {} : { speed: options.speed }),
  });
  return { adapter, script, media, gateway };
}

const AUDIO = mp3Bytes(2048);

describe("the stream of a speech answer (joined and decoded, not guessed)", () => {
  it("joins the chunks in order, decodes each on its own, and keeps the first event's generation id", () => {
    // Chunk sizes that are not multiples of three: each chunk's base64 carries its own padding, so joining the text first would corrupt it.
    const stream = speechFromStream(new TextDecoder().decode(streamOf(AUDIO, { chunkSizes: [1001, 500, 547] })));
    assert.equal(stream.ok, true);
    if (!stream.ok) return;
    assert.deepEqual(Array.from(stream.bytes), Array.from(AUDIO));
    assert.equal(stream.generationId, GENERATION);
  });

  it("a stream without an id names no generation, so no bill can be read later", () => {
    const stream = speechFromStream(new TextDecoder().decode(streamOf(AUDIO, { id: null })));
    assert.equal(stream.ok, true);
    if (stream.ok) assert.equal(stream.generationId, null);
  });

  it("comment lines and null fields are ignored, as the documented shape allows", () => {
    const stream = speechFromStream(new TextDecoder().decode(streamOf(AUDIO, { nullFields: true })));
    assert.equal(stream.ok, true);
    if (stream.ok) assert.equal(stream.bytes.byteLength, AUDIO.byteLength);
  });

  it("an error event is refused with its message, and no audio is taken from the events before it", () => {
    const text = `data: ${JSON.stringify({ id: GENERATION, choices: [{ delta: { audio: { data: base64(AUDIO) } } }] })}\n\ndata: ${JSON.stringify({ error: { message: "voice not found" } })}\n\ndata: [DONE]\n`;
    const stream = speechFromStream(text);
    assert.equal(stream.ok, false);
    if (!stream.ok) assert.match(stream.reason, /stream reported an error: .*voice not found/);
  });

  it("a chunk that is not base64 is refused", () => {
    const text = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: "not base64!" } } }] })}\n\ndata: [DONE]\n`;
    const stream = speechFromStream(text);
    assert.equal(stream.ok, false);
    if (!stream.ok) assert.match(stream.reason, /not base64/);
  });

  it("a stream that ends before [DONE] is refused, because its audio may be cut short", () => {
    const stream = speechFromStream(new TextDecoder().decode(streamOf(AUDIO, { withDone: false })));
    assert.equal(stream.ok, false);
    if (!stream.ok) assert.match(stream.reason, /before its \[DONE\]/);
  });

  it("a stream with no audio is refused", () => {
    const stream = speechFromStream("data: " + JSON.stringify({ id: GENERATION, choices: [{ delta: { content: "hi" } }] }) + "\n\ndata: [DONE]\n");
    assert.equal(stream.ok, false);
    if (!stream.ok) assert.match(stream.reason, /no audio/);
  });

  it("a line that is not JSON is refused, never skipped", () => {
    const stream = speechFromStream("data: {not json\n\ndata: [DONE]\n");
    assert.equal(stream.ok, false);
  });
});

describe("OpenRouter speech: the request and the answer", () => {
  it("sends chat completions with audio output as a stream, stores the MP3, and keeps the generation id", async () => {
    const { adapter, script, media } = setup({
      [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS),
      [STATS]: json(200, statsWithoutCost),
    });
    const spec = assetSpec({ modelClass: "tts", prompt: "Two scoops, one sentence.", durationMs: 1000 });
    const { jobRef } = await adapter.submit(spec, "sha256:tts");
    const poll = await adapter.poll(jobRef);

    assert.equal(poll.state, "done");
    assert.match(poll.uri ?? "", /^memory:\/\/org_1\//);
    assert.equal(poll.actualUsd, undefined, "the stats name no cost: the submit stays unsettled");
    assert.equal([...media.objects.values()][0]?.mediaType, "audio/mpeg");
    assert.deepEqual(adapter.detailsFor(jobRef), { mediaType: "audio/mpeg", generationId: GENERATION });

    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(sent.model, "elevenlabs/eleven-v4");
    assert.deepEqual(sent.modalities, ["text", "audio"]);
    assert.deepEqual(sent.audio, { voice: "voice_warm_01", format: "mp3" });
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages, [{ role: "user", content: "Two scoops, one sentence." }]);
    assert.equal("speed" in sent, false, "the default pace is not sent");
  });

  it("refuses an answer whose stream is not usable: nothing is stored, and the poll fails without a bill", async () => {
    const { adapter, script, media } = setup({ [CHAT]: raw(200, streamOf(AUDIO, { withDone: false }), STREAM_HEADERS) });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts" }), "k");
    const poll = await adapter.poll(jobRef);
    assert.equal(poll.state, "failed");
    assert.equal(poll.error?.kind, "unknown");
    assert.equal(media.objects.size, 0);
    assert.equal(script.requests.filter((request) => request.method === "GET").length, 0, "no stats are read for an unusable take");
  });

  it("refuses a stream whose audio is not an MP3", async () => {
    const wav = new Uint8Array(2048);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    const { adapter } = setup({ [CHAT]: raw(200, streamOf(wav), STREAM_HEADERS) });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts" }), "k");
    const poll = await adapter.poll(jobRef);
    assert.equal(poll.state, "failed");
    assert.match(poll.error?.message ?? "", /MP3 header/);
  });

  it("a rate limit throws as a classified provider error", async () => {
    const { adapter } = setup({ [CHAT]: json(429, { error: "rate limited" }) });
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "tts" }), "k"), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(error.providerError.kind, "rate_limit");
      return true;
    });
  });

  it("prices per million characters of the script (an estimate, from the Bible's $40)", () => {
    const { adapter } = setup({});
    const text = "a".repeat(500);
    assert.equal(adapter.price(assetSpec({ modelClass: "tts", prompt: text })).estimateUsd, 0.02);
  });

  it("the Gemini target is priced per output token, which cannot be known before the call, so it is never estimated", () => {
    const { adapter } = setup({}, { model: "google/gemini-3.8-flash-tts", priceKey: "gemini_3_8_flash_tts", voiceProvider: "google" });
    assert.throws(() => adapter.price(assetSpec({ modelClass: "tts", prompt: "Hello." })), (error: unknown) => error instanceof EngineError && error.kind === "unknown_price");
  });
});

describe("OpenRouter speech: the voice belongs to one provider", () => {
  it("is not connected without a voice, and sends nothing", async () => {
    const { adapter, script } = setup({ [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS) }, { voice: null });
    const connection = await adapter.connection("org_1");
    assert.equal(connection.connected, false);
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "tts" }), "k"), EngineError);
    assert.equal(script.requests.length, 0);
  });

  it("is not connected for a voice of another provider, and sends nothing", async () => {
    const { adapter, script } = setup({ [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS) }, { voiceProvider: "google" });
    const connection = await adapter.connection("org_1");
    assert.equal(connection.connected, false);
    assert.match(connection.connected ? "" : connection.reason, /belongs to google, not to elevenlabs/);
    assert.equal(script.requests.length, 0);
  });

  it("is not connected for a voice that names no provider", async () => {
    const { adapter } = setup({}, { voiceProvider: null });
    const connection = await adapter.connection("org_1");
    assert.equal(connection.connected, false);
  });

  it("is connected when the voice's provider is the model's vendor", async () => {
    const { adapter } = setup({}, { model: "google/gemini-3.8-flash-tts", voiceProvider: "Google" });
    assert.deepEqual(await adapter.connection("org_1"), { connected: true });
    assert.equal(vendorOf("elevenlabs/eleven-v4"), "elevenlabs");
  });
});

describe("OpenRouter speech bill (the generation stats, read once after the audio is stored)", () => {
  it("settles a finished take to the stats' total_cost in USD, and reads the stats once", async () => {
    const { adapter, script } = setup({
      [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS),
      [STATS]: json(200, statsWithCost),
    });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts", prompt: "Settled." }), "k");
    const first = await adapter.poll(jobRef);
    const second = await adapter.poll(jobRef);
    assert.equal(first.actualUsd, 0.0031);
    assert.equal(second.actualUsd, 0.0031);
    const reads = script.requests.filter((request) => request.method === "GET");
    assert.equal(reads.length, 1, "the stats are read once");
    assert.equal(reads[0]?.url, `https://openrouter.ai/api/v1/generation?id=${GENERATION}`);
  });

  it("a stats read that misses leaves the submit unsettled, and is not asked again", async () => {
    const { adapter, script } = setup({
      [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS),
      [STATS]: json(404, { error: "generation not found yet" }),
    });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts", prompt: "Stats lag." }), "k");
    const poll = await adapter.poll(jobRef);
    await adapter.poll(jobRef);
    assert.equal(poll.state, "done");
    assert.equal(poll.actualUsd, undefined, "no bill: the router keeps the submit unsettled");
    assert.equal(script.requests.filter((request) => request.method === "GET").length, 1);
  });

  it("stats with no total_cost are a miss, not a bill of zero", async () => {
    const { adapter } = setup({
      [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS),
      [STATS]: json(200, statsWithoutCost),
    });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts", prompt: "No cost." }), "k");
    assert.equal((await adapter.poll(jobRef)).actualUsd, undefined);
  });

  it("a stream with no generation id makes no stats read, and stays unsettled", async () => {
    const { adapter, script } = setup({ [CHAT]: raw(200, streamOf(AUDIO, { id: null }), STREAM_HEADERS) });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts", prompt: "No id." }), "k");
    assert.equal((await adapter.poll(jobRef)).actualUsd, undefined);
    assert.equal(script.requests.filter((request) => request.method === "GET").length, 0);
  });
});

describe("OpenRouter speech speed (the voice stage paces a take with it)", () => {
  it("sends a non-default speed and names it in the adapter identity, so a cache key cannot mix paces", async () => {
    const { adapter, script } = setup({ [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS) }, { speed: 1.2 });
    assert.equal(adapter.id, "openrouter:elevenlabs/eleven-v4@speed=1.2");
    await adapter.submit(assetSpec({ modelClass: "tts", prompt: "Faster." }), "k");
    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal(sent.speed, 1.2);
  });

  it("keeps the default identity and sends no speed at the default rate", async () => {
    const { adapter, script } = setup({ [CHAT]: raw(200, streamOf(AUDIO), STREAM_HEADERS) });
    assert.equal(adapter.id, "openrouter:elevenlabs/eleven-v4");
    await adapter.submit(assetSpec({ modelClass: "tts", prompt: "Normal." }), "k");
    assert.equal("speed" in JSON.parse(String(script.requests[0]?.body)), false);
  });

  it("refuses a speed outside the accepted range before any request is made", () => {
    assert.throws(() => setup({}, { speed: SPEECH_SPEED_RANGE.max + 0.1 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(() => setup({}, { speed: Number.NaN }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });
});
