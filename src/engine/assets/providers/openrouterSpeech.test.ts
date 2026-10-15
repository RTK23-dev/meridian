import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../../contracts/errors.ts";
import { ProviderCallError } from "../classify.ts";
import { memoryMediaStore } from "../adapter.ts";
import { assetSpec, gatewayFor, json, mp3Bytes, raw, routesWith, scripted } from "../test/recorded.ts";
import { openRouterSpeechAdapter, SPEECH_SPEED_RANGE } from "./openrouterSpeech.ts";
import { routes } from "../../config/routes.ts";

const PATH = "POST /api/v1/audio/speech";

function setup(replies: Parameters<typeof scripted>[0], voice: string | null = "voice_warm_01", model: string | null = "test/eleven-v4", speed?: number) {
  const script = scripted(replies);
  const table = routesWith("tts", [{ provider: "openrouter", model, priceKey: "eleven_v4", verified: false }], routes.table);
  const gateway = gatewayFor(script.transport, { routes: table });
  const route = gateway.routes("tts")[0];
  if (!route) throw new Error("no tts route");
  const media = memoryMediaStore();
  const adapter = openRouterSpeechAdapter({ gateway, organizationId: "org_1", workspaceId: "org_1", route, media, voice, ...(speed === undefined ? {} : { speed }) });
  return { adapter, script, media, gateway };
}

describe("OpenRouter speech", () => {
  it("sends the voice and text as MP3, stores the bytes, and keeps the generation id", async () => {
    const { adapter, script, media } = setup({
      [PATH]: raw(200, mp3Bytes(), { "content-type": "audio/mpeg", "x-generation-id": "gen-speech-1" }),
    });
    const spec = assetSpec({ modelClass: "tts", prompt: "Two scoops, one sentence.", durationMs: 1000 });
    const { jobRef } = await adapter.submit(spec, "sha256:tts");
    const poll = await adapter.poll(jobRef);

    assert.equal(poll.state, "done");
    assert.match(poll.uri ?? "", /^memory:\/\/org_1\//);
    assert.equal(poll.actualUsd, undefined, "no bill in the answer: the router holds the list estimate");
    assert.equal([...media.objects.values()][0]?.mediaType, "audio/mpeg");
    assert.deepEqual(adapter.detailsFor(jobRef), { mediaType: "audio/mpeg", generationId: "gen-speech-1" });

    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/audio/speech");
    assert.equal(sent.model, "test/eleven-v4");
    assert.equal(sent.input, "Two scoops, one sentence.");
    assert.equal(sent.voice, "voice_warm_01");
    assert.equal(sent.response_format, "mp3");
  });

  it("prices per million characters of the script (an estimate)", () => {
    const { adapter } = setup({});
    const text = "a".repeat(500);
    assert.equal(adapter.price(assetSpec({ modelClass: "tts", prompt: text })).estimateUsd, 0.02);
  });

  it("is not connected without a voice, and sends nothing", async () => {
    const { adapter, script } = setup({ [PATH]: raw(200, mp3Bytes(), { "content-type": "audio/mpeg" }) }, null);
    const connection = await adapter.connection("org_1");
    assert.equal(connection.connected, false);
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "tts" }), "k"), EngineError);
    assert.equal(script.requests.length, 0);
  });

  it("fails the poll when the answer is not MP3", async () => {
    const { adapter } = setup({ [PATH]: raw(200, mp3Bytes(), { "content-type": "audio/wav" }) });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "tts" }), "k");
    const poll = await adapter.poll(jobRef);
    assert.equal(poll.state, "failed");
    assert.equal(poll.error?.kind, "unknown");
  });

  it("a rate limit throws as a classified provider error", async () => {
    const { adapter } = setup({ [PATH]: json(429, { error: "rate limited" }) });
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "tts" }), "k"), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(error.providerError.kind, "rate_limit");
      return true;
    });
  });
});

describe("OpenRouter speech speed (the voice stage paces a take with it)", () => {
  it("sends a non-default speed and names it in the adapter identity, so a cache key cannot mix paces", async () => {
    const { adapter, script } = setup({ [PATH]: raw(200, mp3Bytes(), { "content-type": "audio/mpeg" }) }, "voice_warm_01", "test/eleven-v4", 1.2);
    assert.equal(adapter.id, "openrouter:test/eleven-v4@speed=1.2");
    await adapter.submit(assetSpec({ modelClass: "tts", prompt: "Faster." }), "k");
    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal(sent.speed, 1.2);
  });

  it("keeps the default identity and sends no speed at the default rate", async () => {
    const { adapter, script } = setup({ [PATH]: raw(200, mp3Bytes(), { "content-type": "audio/mpeg" }) });
    assert.equal(adapter.id, "openrouter:test/eleven-v4");
    await adapter.submit(assetSpec({ modelClass: "tts", prompt: "Normal." }), "k");
    assert.equal("speed" in JSON.parse(String(script.requests[0]?.body)), false);
  });

  it("refuses a speed outside the accepted range before any request is made", () => {
    assert.throws(() => setup({}, "voice_warm_01", "test/eleven-v4", SPEECH_SPEED_RANGE.max + 0.1), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(() => setup({}, "voice_warm_01", "test/eleven-v4", Number.NaN), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });
});
