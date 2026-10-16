// The detector routes of the serverless entry point (functions/ffmpeg/http.ts): POST /black, /flicker, /motion and /silence.
// The refusals run without ffmpeg. The answers and the round trip through httpMediaFunctions run the real handlers and need ffmpeg.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMediaRequest } from "../../../functions/ffmpeg/http.ts";
import {
  blackFramesResultSchema,
  flickerResultSchema,
  motionResultSchema,
  silenceResultSchema,
} from "../../../functions/ffmpeg/types.ts";
import { httpMediaFunctions } from "./http.ts";
import type { MediaTransport } from "./wire-client.ts";
import { detectorClipBytes } from "./test/detector-clips.ts";
import { ffmpegSkipReason } from "../test/media-fixture.ts";

const BASE = "https://media.test";
const SKIP = ffmpegSkipReason() ?? false;
const DETECTOR_ROUTES = ["/black", "/flicker", "/motion", "/silence"] as const;

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function send(request: Request): Promise<{ status: number; body: string }> {
  const response = await handleMediaRequest(request);
  return { status: response.status, body: await response.text() };
}

describe("the detector routes: typed refusals (no ffmpeg needed)", () => {
  it("refuses a body with an unknown key with 400 invalid_input, on every detector route", async () => {
    for (const path of DETECTOR_ROUTES) {
      const answer = await send(
        post(path, { source: { kind: "url", url: "https://media.example.test/a.mp4" }, extra: 1 }),
      );
      assert.equal(answer.status, 400, path);
      assert.equal(
        (JSON.parse(answer.body) as { error: { kind: string } }).error.kind,
        "invalid_input",
        path,
      );
    }
  });

  it("refuses inline bytes that are not base64 with 400 invalid_input", async () => {
    const answer = await send(
      post("/silence", { source: { kind: "bytes", base64: "not base64!" } }),
    );
    assert.equal(answer.status, 400);
  });

  it("answers GET on a detector route with 405, as the other routes do", async () => {
    const answer = await send(new Request(`${BASE}/black`, { method: "GET" }));
    assert.equal(answer.status, 405);
  });
});

describe("the detector routes end to end (real ffmpeg)", { skip: SKIP }, () => {
  it("each route answers 200 with a body that matches its result schema", async () => {
    const video = Buffer.from(await detectorClipBytes("black-gap")).toString("base64");
    const black = await send(post("/black", { source: { kind: "bytes", base64: video } }));
    assert.equal(black.status, 200, black.body);
    assert.equal(blackFramesResultSchema.safeParse(JSON.parse(black.body)).success, true);

    const flicker = await send(post("/flicker", { source: { kind: "bytes", base64: video } }));
    assert.equal(flickerResultSchema.safeParse(JSON.parse(flicker.body)).success, true);

    const motion = await send(post("/motion", { source: { kind: "bytes", base64: video } }));
    assert.equal(motionResultSchema.safeParse(JSON.parse(motion.body)).success, true);

    const tone = Buffer.from(await detectorClipBytes("tone-gap")).toString("base64");
    const silence = await send(post("/silence", { source: { kind: "bytes", base64: tone } }));
    assert.equal(silence.status, 200, silence.body);
    assert.equal(silenceResultSchema.safeParse(JSON.parse(silence.body)).success, true);
  });

  it("the client and the handler agree on the four detectors (the transport calls the handler)", async () => {
    const transport: MediaTransport = async (request) => {
      const response = await handleMediaRequest(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
      );
      return { status: response.status, body: await response.text() };
    };
    const functions = httpMediaFunctions(BASE, transport);
    const black = await functions.blackFrames({
      source: { kind: "bytes", bytes: await detectorClipBytes("black-gap") },
    });
    assert.equal(black.blackRuns.length, 1);
    assert.equal(black.fps, 30);

    const flicker = await functions.flicker({
      source: { kind: "bytes", bytes: await detectorClipBytes("flicker") },
    });
    assert.ok(flicker.flickerScore !== null && flicker.flickerScore > 0.9);

    const motion = await functions.motion({
      source: { kind: "bytes", bytes: await detectorClipBytes("pan") },
    });
    assert.ok(motion.meanMotion !== null && motion.meanMotion > 0.05);

    const silence = await functions.silence({
      source: { kind: "bytes", bytes: await detectorClipBytes("tone-gap") },
    });
    assert.equal(silence.silences.length, 1);
  });
});
