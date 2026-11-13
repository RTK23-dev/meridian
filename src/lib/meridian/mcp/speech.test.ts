// The connector's speech helpers, against rows recorded from OpenRouter's GET /models?output_modalities=speech (2026-11-09).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSpeechListing, readLaggingBill, speechModelLine, speechRequestBody, VOICE_HOLD_FLOOR_USD, voiceHoldUsd, voiceProblem } from "./speech.ts";

describe("what a voiceover holds, and reading its bill", () => {
  it("holds the text at the list rate with a margin: cents for a few lines, the ceiling only when the rate is not stated", () => {
    const v4 = { usdPerCharacter: 0.00008 };
    assert.equal(voiceHoldUsd(v4, 72, 1), 0.02, "72 characters at $0.08 per 1,000, doubled, rounded up to a cent");
    assert.equal(voiceHoldUsd(v4, 4000, 1), 0.64, "the longest text the tool takes");
    assert.equal(voiceHoldUsd(v4, 10, 1), VOICE_HOLD_FLOOR_USD, "never less than a cent");
    assert.equal(voiceHoldUsd({ usdPerCharacter: 0 }, 500, 1), VOICE_HOLD_FLOOR_USD, "a free model still reserves the floor");
    assert.equal(voiceHoldUsd({ usdPerCharacter: 0.001 }, 4000, 1), 1, "never more than the ceiling");
    assert.equal(voiceHoldUsd({ usdPerCharacter: null }, 72, 1), 1, "no stated rate: the ceiling");
  });

  it("reads a lagging bill again after each wait, and stops at the first billed answer", async () => {
    const waited: number[] = [];
    const wait = async (ms: number) => void waited.push(ms);
    const answers = [{ status: "unavailable" }, { status: "unavailable" }, { status: "billed", usd: 0.006 }, { status: "billed", usd: 9 }];
    let reads = 0;
    const bill = await readLaggingBill(async () => answers[reads++]!, [800, 1500, 2500], wait);
    assert.deepEqual(bill, { status: "billed", usd: 0.006 });
    assert.deepEqual([reads, waited], [3, [800, 1500]]);

    reads = 0;
    waited.length = 0;
    const missed = await readLaggingBill(async () => ({ status: "unavailable", n: ++reads }), [800, 1500], wait);
    assert.deepEqual([missed.status, reads, waited], ["unavailable", 3, [800, 1500]]);

    reads = 0;
    waited.length = 0;
    await readLaggingBill(async () => ({ status: "billed", n: ++reads }), [800, 1500], wait);
    assert.deepEqual([reads, waited], [1, []], "a bill that is ready is read once, with no wait");
  });
});

const LISTING = {
  data: [
    { id: "elevenlabs/eleven-v3", name: "ElevenLabs: Eleven v3", created: 1791331200, architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.00008" }, supported_voices: ["george", "sarah", "adam"] },
    { id: "elevenlabs/eleven-v4", name: "ElevenLabs: Eleven v4", created: 1791331200, description: "Eleven v4 is a text-to-speech model from ElevenLabs. It is ElevenLabs' most expressive model.", architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.00008" }, supported_voices: ["will", "chris"] },
    { id: "elevenlabs/eleven-flash-v2", created: 1791331200, architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.00004" }, supported_voices: ["will"] },
    { id: "hexgrad/kokoro-82m", created: 1776902400, architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.00000062" }, supported_voices: ["af_alloy", "af_bella"] },
    { id: "fish-audio/drama-3", created: 1791849600, architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.000002" }, supported_voices: null },
    { id: "heygen/heygen-voice-1-turbo:free", architecture: { output_modalities: ["speech"] }, pricing: {}, supported_voices: ["nadine"] },
    { id: "openai/gpt-5", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000001" } },
    { id: 42, pricing: { prompt: "1" } },
  ],
};

describe("the speech listing", () => {
  it("keeps the speech models, newest first and flagship first, with their rate per character and voices; leaves out other rows and bad rows", () => {
    const models = parseSpeechListing(LISTING);
    assert.deepEqual(models.map((model) => model.id), [
      "fish-audio/drama-3",
      "elevenlabs/eleven-v4",
      "elevenlabs/eleven-v3",
      "elevenlabs/eleven-flash-v2",
      "hexgrad/kokoro-82m",
      "heygen/heygen-voice-1-turbo:free",
    ]);
    const v4 = models.find((model) => model.id === "elevenlabs/eleven-v4")!;
    assert.equal(v4.listedOn, "2026-10-07");
    assert.equal(v4.summary, "Eleven v4 is a text-to-speech model from ElevenLabs.");
    const eleven = models.find((model) => model.id === "elevenlabs/eleven-v3")!;
    assert.equal(eleven.usdPerCharacter, 0.00008);
    assert.deepEqual(eleven.voices, ["george", "sarah", "adam"]);
    assert.equal(models.find((model) => model.id === "fish-audio/drama-3")!.voices, null, "no listed voices is null, not an empty list");
    assert.equal(models.find((model) => model.id.endsWith(":free"))!.usdPerCharacter, null, "an unstated rate stays unknown, never 0");
    assert.deepEqual(parseSpeechListing({ nothing: true }), []);
  });

  it("checks a voice against the model's own voices, and asks a model that lists none as given", () => {
    const models = parseSpeechListing(LISTING);
    const kokoro = models.find((model) => model.id === "hexgrad/kokoro-82m");
    const drama = models.find((model) => model.id === "fish-audio/drama-3");
    assert.equal(voiceProblem(kokoro!, "af_bella"), null);
    assert.match(voiceProblem(kokoro!, "alloy") ?? "", /hexgrad\/kokoro-82m has no voice 'alloy'\. Its voices include: af_alloy, af_bella\./);
    assert.equal(voiceProblem(drama!, "anyone"), null);
  });

  it("asks for MP3, and sends a pace and a delivery style only when they are given", () => {
    assert.deepEqual(JSON.parse(speechRequestBody({ model: "m", text: "Hi.", voice: "george", speed: 1 })), { model: "m", input: "Hi.", voice: "george", response_format: "mp3" });
    assert.deepEqual(JSON.parse(speechRequestBody({ model: "m", text: "Hi.", voice: "george", speed: 1.1, instructions: "upbeat" })), {
      model: "m", input: "Hi.", voice: "george", response_format: "mp3", speed: 1.1, instructions: "upbeat",
    });
  });

  it("shows when each model was listed, its rate per 1,000 characters, what it is, and its voices", () => {
    const models = parseSpeechListing(LISTING);
    assert.equal(
      speechModelLine(models.find((model) => model.id === "elevenlabs/eleven-v4")!),
      "elevenlabs/eleven-v4 (listed 2026-10-07): $0.0800 per 1,000 characters. Eleven v4 is a text-to-speech model from ElevenLabs. voices: will, chris",
    );
    assert.equal(speechModelLine(models.find((model) => model.id === "fish-audio/drama-3")!), "fish-audio/drama-3 (listed 2026-10-13): $0.0020 per 1,000 characters. voices: not listed");
    assert.match(speechModelLine(models.find((model) => model.id.endsWith(":free"))!), /price not stated/);
  });
});
