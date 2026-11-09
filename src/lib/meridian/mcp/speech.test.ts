// The connector's speech helpers, against rows recorded from OpenRouter's GET /models?output_modalities=speech (2026-11-09).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSpeechListing, speechModelLine, speechRequestBody, voiceProblem } from "./speech.ts";

const LISTING = {
  data: [
    { id: "elevenlabs/eleven-v3", name: "ElevenLabs: Eleven v3", architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.00008" }, supported_voices: ["george", "sarah", "adam"] },
    { id: "hexgrad/kokoro-82m", architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.00000062" }, supported_voices: ["af_alloy", "af_bella"] },
    { id: "fish-audio/drama-3", architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.000002" }, supported_voices: null },
    { id: "heygen/heygen-voice-1-turbo:free", architecture: { output_modalities: ["speech"] }, pricing: {}, supported_voices: ["nadine"] },
    { id: "openai/gpt-5", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000001" } },
    { id: 42, pricing: { prompt: "1" } },
  ],
};

describe("the speech listing", () => {
  it("keeps the speech models, cheapest first, with their rate per character and voices; leaves out other rows and bad rows", () => {
    const models = parseSpeechListing(LISTING);
    assert.deepEqual(models.map((model) => model.id), ["hexgrad/kokoro-82m", "fish-audio/drama-3", "elevenlabs/eleven-v3", "heygen/heygen-voice-1-turbo:free"]);
    const eleven = models.find((model) => model.id === "elevenlabs/eleven-v3")!;
    assert.equal(eleven.usdPerCharacter, 0.00008);
    assert.deepEqual(eleven.voices, ["george", "sarah", "adam"]);
    assert.equal(models.find((model) => model.id === "fish-audio/drama-3")!.voices, null, "no listed voices is null, not an empty list");
    assert.equal(models.find((model) => model.id.endsWith(":free"))!.usdPerCharacter, null, "an unstated rate stays unknown, never 0");
    assert.deepEqual(parseSpeechListing({ nothing: true }), []);
  });

  it("checks a voice against the model's own voices, and asks a model that lists none as given", () => {
    const [kokoro, drama] = parseSpeechListing(LISTING);
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

  it("shows each model's rate per 1,000 characters and a few of its voices", () => {
    const models = parseSpeechListing(LISTING);
    assert.equal(speechModelLine(models.find((model) => model.id === "elevenlabs/eleven-v3")!), "elevenlabs/eleven-v3: $0.0800 per 1,000 characters; voices: george, sarah, adam");
    assert.equal(speechModelLine(models.find((model) => model.id === "fish-audio/drama-3")!), "fish-audio/drama-3: $0.0020 per 1,000 characters; voices: not listed");
    assert.match(speechModelLine(models.find((model) => model.id.endsWith(":free"))!), /price not stated/);
  });
});
