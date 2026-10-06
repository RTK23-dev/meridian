import assert from "node:assert/strict";
import test from "node:test";
import { advanceTestVideo, startTestVideo } from "../providers/media.ts";
import { judgeMedia, rollupDecision } from "../studio/features.ts";
import { TEST_VIDEO_MAX_POLLS } from "../studio/media-work.ts";
import { inspectVideo, videoFactsFromInspection } from "./inspect.ts";
import { readMp4Timing, videoQa } from "./provider.ts";
import { pollXaiVideo, submitXaiVideo } from "./xai.ts";
import type { Transport } from "../providers/http.ts";

const prompt = "Show the lather. Do not invent a cure. secret-prompt-line";

test("the test fixture stores timing and frames and does not copy the prompt into a transcript", () => {
  const started = startTestVideo({ prompt, seed: "seed-1", promptVersion: "v1" }, true);
  assert.equal(started.status, "queued");
  assert.equal(started.bytes, null);
  const submitted = advanceTestVideo(started, true);
  const processing = advanceTestVideo(submitted, true);
  const done = advanceTestVideo(processing, true);
  const again = advanceTestVideo(done, true);
  assert.equal(done.status, "completed");
  assert.equal(again.status, "completed");
  assert.equal(again.attempts, done.attempts);
  assert.equal(done.transcript, "");
  assert.equal(done.transcript.includes(prompt), false);
  assert.equal(JSON.stringify(done.scenes).includes(prompt), false);
  assert.match(done.scenes[0]?.summary ?? "", /not a camera recording/);
  const bytes = done.bytes ?? new Uint8Array();
  const inspected = inspectVideo(bytes);
  assert.equal(readMp4Timing(bytes)?.durationMs, 2500);
  assert.equal(inspected.durationMs, 2500);
  assert.equal(inspected.width, 64);
  assert.equal(inspected.height, 64);
  assert.equal(inspected.container, "mp4");
  assert.ok(inspected.frames.length >= 2);
  assert.equal(done.durationMs, inspected.durationMs);
  assert.equal(done.frameRate, null);
  const stripped = advanceTestVideo({ ...done, bytes: null }, true);
  assert.equal(stripped.status, "completed");
  assert.equal(stripped.objectKey, done.objectKey);
  assert.ok((stripped.bytes?.byteLength ?? 0) > 16);
  assert.equal(stripped.transcript, "");
});

test("a disabled test provider and a missing xAI key do not invent a clip", async () => {
  assert.throws(() => startTestVideo({ prompt, seed: "x", promptVersion: "v" }, false), /not enabled/);
  const missing = await submitXaiVideo({ prompt, apiKey: "" });
  assert.equal(missing.status, "not_connected");
  assert.equal(missing.bytes, null);
  assert.match(missing.error, /EXTERNAL_CONNECTION_REQUIRED/);
});

test("a video provider failure is retried, and a malformed response is not stored", async () => {
  let calls = 0;
  const recovered = await submitXaiVideo({
    prompt,
    apiKey: "test-key",
    transport: (async () => {
      calls += 1;
      if (calls === 1) return { status: 503, body: "", headers: { "retry-after": "0" } };
      return { status: 200, body: JSON.stringify({ request_id: "req-9" }), headers: { "retry-after": "0" } };
    }) satisfies Transport,
  });
  assert.equal(recovered.status, "submitted");
  assert.equal(recovered.providerJobId, "req-9");
  assert.ok(calls >= 2);
  const malformed = await pollXaiVideo(
    { ...recovered, status: "submitted" },
    { apiKey: "test-key", transport: async () => ({ status: 200, body: "{", headers: {} }) },
  );
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.bytes, null);
  assert.equal(TEST_VIDEO_MAX_POLLS, 4);
});

test("bytes that are not a container do not become a successful watch", () => {
  const inspected = inspectVideo(new Uint8Array([1, 2, 3, 4]));
  const facts = videoFactsFromInspection(inspected, 4);
  assert.equal(facts.durationMs, null);
  assert.equal(facts.transcript, "");
  assert.match(facts.scene, /vision was not run/i);
  assert.equal(videoQa(null).decision, "HUMAN_REVIEW");
  assert.equal(videoQa({ durationMs: 2500, width: 64, height: 64, frameRate: null, audio: "unknown", transcript: "", scenes: [] }).decision, "HUMAN_REVIEW");
});

test("missing vision stays in review and a logo mismatch is a rejection", () => {
  const base = {
    kind: "video" as const,
    positioning: "The point is the lather.",
    tone: "plain",
    prohibited: "",
    wordsToAvoid: "",
    productName: "Lather bar",
    angle: "lather_proof",
    copy: "Lather bar, shown in one take.",
    prompt: "Still of Lather bar.",
    competitorTexts: [],
    ownTexts: [],
    mime: "video/mp4",
    byteSize: 800,
    width: 64,
    height: 64,
    checksum: "abc123def4567890",
    durationMs: 2500,
    transcript: "",
    sceneCount: 1,
    logoSimilarity: null as number | null,
    logoOutcome: "ABSENT" as const,
    logoEvidence: "No sampled frame was stored. Logo presence was not invented.",
    paletteDistance: null as number | null,
    paletteOutcome: "ABSENT" as const,
    paletteEvidence: "No sampled frame was stored.",
    semanticSimilarity: null,
  };
  const missing = judgeMedia(base);
  assert.equal(missing.find((item) => item.questionId === "logo_match")?.decision, "HUMAN_REVIEW");
  assert.notEqual(rollupDecision(missing), "AUTO_APPROVE");
  const rejected = judgeMedia({
    ...base,
    logoSimilarity: 0.2,
    logoOutcome: "MISMATCH",
    logoEvidence: "2 frame(s) measured. The stored mark is not in the creative.",
  });
  assert.equal(rejected.find((item) => item.questionId === "logo_match")?.decision, "REJECT");
  assert.equal(rollupDecision(rejected), "REJECT");
});
