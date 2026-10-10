import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { solidFrame } from "../video/inspect.ts";
import { GEMINI_PERCEPTION_MAX_MEDIA, GEMINI_PERCEPTION_PROMPT_VERSION, GeminiPerceptionProvider, parseGeminiObservations } from "./multimodal.ts";
import type { PerceptionMedia } from "./types.ts";

const frameA = solidFrame(16, 16, [255, 0, 0]);
const frameB = solidFrame(16, 16, [0, 0, 255]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const media = (bytes: Uint8Array, id: string, timestampMs: number | null): PerceptionMedia => ({
  id, bytes, mimeType: "image/png", sha256: hash(bytes), timestampMs,
});
const KEY = "test-key-not-real";

type Captured = { url: string; headers: Record<string, string>; body: { contents: Array<{ parts: Array<{ text?: string }> }> } };

function geminiReply(text: string, usage?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage }),
  } as unknown as Response;
}

function provider(fetchImpl: (captured: Captured) => Promise<Response> | Response) {
  const calls: Captured[] = [];
  const instance = new GeminiPerceptionProvider("gemini-test-model", {
    fetchImpl: (async (url: string, init: RequestInit) => {
      const captured = { url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      calls.push(captured);
      return fetchImpl(captured);
    }) as typeof fetch,
  });
  return { instance, calls };
}

test("frames are described by index: each observation carries its real timestamp, hash, and the inferred basis", async () => {
  const { instance, calls } = provider(() =>
    geminiReply(JSON.stringify([
      { index: 0, shotType: "close_up", productPresence: true, productProminence: "prominent", productObstructed: false, ocrText: "Lather bar" },
      { index: 1, shotType: "medium_shot", productPresence: false, productProminence: "not_visible", productObstructed: null, ocrText: "" },
    ]), { promptTokenCount: 900, candidatesTokenCount: 120, totalTokenCount: 1020 }),
  );
  const result = await instance.perceive({ kind: "video_frames", media: [media(frameA, "f0", 0), media(frameB, "f1", 2750)] }, { apiKey: KEY });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") return;
  assert.equal(calls.length, 1, "one call for the two frames");
  assert.equal(result.promptVersion, GEMINI_PERCEPTION_PROMPT_VERSION);
  const [first, second] = result.observations;
  assert.equal(first?.mediaId, "f0");
  assert.equal(first?.timestampMs, 0, "the real timestamp of the first frame");
  assert.equal(first?.sha256, hash(frameA));
  assert.equal(first?.basis, "inferred", "every provider observation is an inference from the pixels");
  assert.equal(first?.productPresence, true);
  assert.equal(first?.productProminence, "prominent");
  assert.equal(second?.timestampMs, 2750);
  assert.equal(second?.productObstructed, null, "a value reported as unknown stays unknown");
  assert.equal(second?.ocrText, undefined, "an empty text is not reported as text");
  for (const observation of result.observations) {
    assert.equal("endMs" in observation, false, "no end time is invented");
    assert.equal("modelQualityEstimate" in observation, false, "no quality score is invented");
  }
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 120, totalTokens: 1020 });
});

test("a fact the model did not report stays absent: it is not turned into a negative", () => {
  const parsed = parseGeminiObservations(JSON.stringify([{ index: 0, shotType: "close_up" }]), [media(frameA, "only", null)]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const observation = parsed.observations[0]!;
  assert.equal(observation.productPresence, undefined, "not reported is not false");
  assert.equal(observation.sharpness, undefined);
  assert.equal(observation.artifactsVisible, undefined);
});

test("a value of the wrong type or outside the allowed set is dropped, not coerced", () => {
  const parsed = parseGeminiObservations(JSON.stringify([{ index: 0, productPresence: "yes", sharpness: "very sharp", lighting: "good", motionIntensity: 4 }]), [media(frameA, "x", null)]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.observations[0]?.productPresence, undefined, "a string is not a boolean");
  assert.equal(parsed.observations[0]?.sharpness, undefined, "a value outside the set is not kept");
  assert.equal(parsed.observations[0]?.lighting, "good");
  assert.equal(parsed.observations[0]?.motionIntensity, undefined, "a number outside 0 to 1 is not kept");
});

test("a still image is described as a still: no timestamp is given to it", async () => {
  const { instance } = provider(() => geminiReply(JSON.stringify([{ index: 0, productPresence: true }])));
  const result = await instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: KEY });
  assert.equal(result.status, "observed");
  if (result.status === "observed") assert.equal(result.observations[0]?.timestampMs, null);
});

test("the key travels in a header and never in the URL", async () => {
  const { instance, calls } = provider(() => geminiReply(JSON.stringify([{ index: 0 }])));
  await instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: "secret-value-abc" });
  assert.equal(calls[0]?.headers["x-goog-api-key"], "secret-value-abc");
  assert.ok(!calls[0]?.url.includes("secret-value-abc"), "the key is not in the URL");
});

test("only the media and the fixed instructions are sent: no copy, prompt or brand text", async () => {
  const { instance, calls } = provider(() => geminiReply(JSON.stringify([{ index: 0 }])));
  await instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: KEY });
  const parts = calls[0]!.body.contents[0]!.parts;
  assert.equal(parts.length, 2, "one instruction part and one image part");
  assert.ok(!JSON.stringify(parts).includes("MealKit"), "no product copy is sent");
});

test("an observation missing for one media item, out of range, or repeated, is a failure and nothing is attached", () => {
  const two = [media(frameA, "a", 0), media(frameB, "b", 1000)];
  assert.equal(parseGeminiObservations(JSON.stringify([{ index: 0 }]), two).ok, false, "a missing observation");
  assert.equal(parseGeminiObservations(JSON.stringify([{ index: 0 }, { index: 5 }]), two).ok, false, "an out-of-range index");
  assert.equal(parseGeminiObservations(JSON.stringify([{ index: 0 }, { index: 0 }]), two).ok, false, "a repeated index");
  assert.equal(parseGeminiObservations("not json", two).ok, false);
  assert.equal(parseGeminiObservations(JSON.stringify({ index: 0 }), two).ok, false, "not an array");
});

test("a malformed response is failed as invalid_response, not as an observation", async () => {
  const { instance } = provider(() => geminiReply("this is not json"));
  const result = await instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: KEY });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.failureKind, "invalid_response");
});

test("provider errors are reported as their own kinds, with no observations", async () => {
  const cases: Array<[number, string]> = [[429, "rate_limited"], [403, "authentication"], [503, "provider_unavailable"], [400, "invalid_response"]];
  for (const [status, kind] of cases) {
    const { instance } = provider(() => ({ ok: false, status, json: async () => ({}) }) as unknown as Response);
    const result = await instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: KEY });
    assert.equal(result.status, "failed", `HTTP ${status}`);
    if (result.status === "failed") assert.equal(result.failureKind, kind);
  }
});

test("a timeout and a network failure are both reported, and neither produces observations", async () => {
  const timeout = provider(() => {
    throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  });
  const timedOut = await timeout.instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: KEY });
  assert.equal(timedOut.status === "failed" && timedOut.failureKind, "timeout");
  const network = provider(() => {
    throw new TypeError("fetch failed");
  });
  const down = await network.instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: KEY });
  assert.equal(down.status === "failed" && down.failureKind, "network");
});

test("no credential supplied means no call at all", async () => {
  const { instance, calls } = provider(() => geminiReply("[]"));
  const result = await instance.perceive({ kind: "image", media: [media(frameA, "still", null)] }, { apiKey: "   " });
  assert.equal(result.status === "failed" && result.failureKind, "not_configured");
  assert.equal(calls.length, 0, "the provider is not called without a credential");
});

test("more media than the bound, invalid bytes, and a hash that does not match are refused before any call", async () => {
  const { instance, calls } = provider(() => geminiReply("[]"));
  const many = Array.from({ length: GEMINI_PERCEPTION_MAX_MEDIA + 1 }, (_, index) => media(frameA, `m${index}`, index * 100));
  const tooMany = await instance.perceive({ kind: "video_frames", media: many }, { apiKey: KEY });
  assert.equal(tooMany.status === "failed" && tooMany.failureKind, "unsupported_media");
  const notAnImage = await instance.perceive({ kind: "image", media: [{ ...media(frameA, "x", null), bytes: new Uint8Array([1, 2, 3]), sha256: hash(new Uint8Array([1, 2, 3])) }] }, { apiKey: KEY });
  assert.equal(notAnImage.status === "failed" && notAnImage.failureKind, "unsupported_media");
  const mismatch = await instance.perceive({ kind: "image", media: [{ ...media(frameA, "y", null), sha256: "0".repeat(64) }] }, { apiKey: KEY });
  assert.equal(mismatch.status === "failed" && mismatch.failureKind, "unsupported_media");
  assert.equal(calls.length, 0);
});
