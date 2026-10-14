// The serverless entry point (functions/ffmpeg/http.ts). Routing, error statuses and body limits run without ffmpeg,
// against the captured answers. The round trip through httpMediaFunctions runs the real handler and needs ffmpeg.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { errorStatus, handleMediaRequest } from "../../../functions/ffmpeg/http.ts";
import { EngineError } from "../contracts/errors.ts";
import { httpMediaFunctions } from "./http.ts";
import type { MediaTransport } from "./wire-client.ts";
import {
  CAPTURED_BAD_JSON_400,
  CAPTURED_UNKNOWN_ROUTE_404,
  CAPTURED_URL_NOT_ALLOWED_400,
  CAPTURED_WRONG_METHOD_405,
} from "../test/fixtures/recorded/media-http.ts";
import { REEL, ffmpegSkipReason, reelPath } from "../test/media-fixture.ts";

const BASE = "https://media.test";
const SKIP = ffmpegSkipReason() ?? false;

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function send(request: Request, options = {}): Promise<{ status: number; body: string }> {
  const response = await handleMediaRequest(request, options);
  return { status: response.status, body: await response.text() };
}

describe("handleMediaRequest: typed errors (no ffmpeg needed)", () => {
  it("refuses a plain-http URL with 400 invalid_input, exactly as captured", async () => {
    const answer = await send(
      post("/probe", { source: { kind: "url", url: "http://127.0.0.1/reel.mp4" } }),
    );
    assert.deepEqual(answer, CAPTURED_URL_NOT_ALLOWED_400);
  });

  it("refuses a body that is not JSON with 400, exactly as captured", async () => {
    assert.deepEqual(await send(post("/probe", "{not json")), CAPTURED_BAD_JSON_400);
  });

  it("answers an unknown path with 404, exactly as captured", async () => {
    assert.deepEqual(await send(post("/nope", {})), CAPTURED_UNKNOWN_ROUTE_404);
  });

  it("answers GET on a POST function with 405, exactly as captured", async () => {
    assert.deepEqual(
      await send(new Request(`${BASE}/probe`, { method: "GET" })),
      CAPTURED_WRONG_METHOD_405,
    );
  });

  it("refuses a body above the size limit with 400 before reading it", async () => {
    const answer = await send(
      post("/probe", {
        source: { kind: "url", url: "https://media.example.com/x.mp4" },
        pad: "x".repeat(200),
      }),
      {
        maxBodyBytes: 100,
      },
    );
    assert.equal(answer.status, 400);
    assert.match(answer.body, /larger than 100 bytes/);
  });

  it("refuses a request with an unknown field, since the wire schemas are strict", async () => {
    const answer = await send(
      post("/cuts", {
        source: { kind: "url", url: "https://media.example.com/x.mp4" },
        sceneScore: 0.3,
        extra: 1,
      }),
    );
    assert.equal(answer.status, 400);
  });

  it("maps every error kind to a status, and a retryable provider error to 503", () => {
    assert.equal(errorStatus(new EngineError("invalid_input", "x")), 400);
    assert.equal(errorStatus(new EngineError("not_found", "x")), 404);
    assert.equal(errorStatus(new EngineError("config", "x")), 500);
    assert.equal(errorStatus(new EngineError("provider", "x", { retryable: true })), 503);
    assert.equal(errorStatus(new EngineError("provider", "x", { retryable: false })), 502);
  });

  it("answers an unknown route without a stack trace or an internal path", async () => {
    const answer = await send(post("/cuts/../../etc", {}));
    assert.equal(answer.status, 404);
    assert.doesNotMatch(answer.body, /\n\s+at |node:|\/home\/|meridian-ffmpeg-/);
  });
});

describe("handleMediaRequest on the generated reel", { skip: SKIP }, () => {
  it("GET /health reports the installed ffmpeg and ffprobe versions", async () => {
    const answer = await send(new Request(`${BASE}/health`, { method: "GET" }));
    assert.equal(answer.status, 200);
    const health = JSON.parse(answer.body) as { ok: boolean; ffmpeg: string; ffprobe: string };
    assert.equal(health.ok, true);
    assert.match(health.ffmpeg, /^ffmpeg version/);
    assert.match(health.ffprobe, /^ffprobe version/);
  });

  it("POST /probe with base64 bytes answers 200 with a probe the client contract accepts", async () => {
    const base64 = (await readFile(await reelPath())).toString("base64");
    const answer = await send(post("/probe", { source: { kind: "bytes", base64 } }));
    assert.equal(answer.status, 200);
    const probe = JSON.parse(answer.body) as { width: number; height: number; durationMs: number };
    assert.equal(probe.width, REEL.width);
    assert.equal(probe.height, REEL.height);
    assert.equal(probe.durationMs, REEL.durationMs);
  });

  it("POST /frames past the end answers 400 invalid_input", async () => {
    const base64 = (await readFile(await reelPath())).toString("base64");
    const answer = await send(post("/frames", { source: { kind: "bytes", base64 }, atMs: [2999] }));
    assert.equal(answer.status, 400);
    assert.equal(
      (JSON.parse(answer.body) as { error: { kind: string } }).error.kind,
      "invalid_input",
    );
  });

  it("the client and the handler agree on every route, end to end (no network: the transport calls the handler)", async () => {
    const reel = new Uint8Array(await readFile(await reelPath()));
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
    const source = { kind: "bytes" as const, bytes: reel };

    const probe = await functions.probe({ source });
    assert.equal(probe.audioPresent, true);

    const cuts = await functions.cuts({ source });
    assert.equal(cuts.cutsMs.length, 2);

    const loudness = await functions.loudness({ source });
    assert.ok(loudness.integratedLufs !== null);

    const frames = await functions.frames({ source, atMs: [500, 1500], longSidePx: 768 });
    assert.deepEqual(
      frames.frames.map((frame) => [frame.atMs, frame.width, frame.height]),
      [
        [500, 432, 768],
        [1500, 432, 768],
      ],
    );
  });
});
