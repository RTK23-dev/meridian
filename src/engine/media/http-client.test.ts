// httpMediaFunctions against recorded responses (no network, no ffmpeg). The captured bodies are the handler's real
// answers; the rate-limit and gateway-timeout bodies are synthetic (see src/engine/test/fixtures/recorded/media-http.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { httpMediaFunctions } from "./http.ts";
import type {
  MediaTransport,
  MediaTransportRequest,
  MediaTransportResponse,
} from "./wire-client.ts";
import {
  CAPTURED_BEYOND_END_400,
  CAPTURED_CUTS_200,
  CAPTURED_FRAMES_200,
  CAPTURED_LOUDNESS_200,
  CAPTURED_PROBE_200,
  CAPTURED_URL_NOT_ALLOWED_400,
  SYNTHETIC_GATEWAY_TIMEOUT_504,
  SYNTHETIC_RATE_LIMIT_429,
} from "../test/fixtures/recorded/media-http.ts";
import { mediaConfig } from "./config.ts";

const BASE = "https://media.test";
const SOURCE = { kind: "bytes" as const, bytes: new Uint8Array([1, 2, 3]) };

/** A transport that answers from a script, one entry per call, and records every request. */
function scripted(responses: Array<MediaTransportResponse | Error>): {
  transport: MediaTransport;
  requests: MediaTransportRequest[];
} {
  const requests: MediaTransportRequest[] = [];
  let next = 0;
  const transport: MediaTransport = async (request) => {
    requests.push(request);
    const response = responses[next];
    next += 1;
    if (response === undefined) {
      throw new Error("the recording has no response left");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { transport, requests };
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to reject");
}

describe("httpMediaFunctions on captured answers", () => {
  it("returns the probe the function reported, validated against the result contract", async () => {
    const { transport, requests } = scripted([CAPTURED_PROBE_200]);
    const probe = await httpMediaFunctions(BASE, transport).probe({ source: SOURCE });
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
    assert.deepEqual(probe.fps, { num: 30, den: 1, value: 30 });
    assert.equal(probe.durationMs, 3000);
    assert.equal(probe.audioPresent, true);
    assert.equal(requests[0]?.url, `${BASE}/probe`);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.timeoutMs, mediaConfig.callTimeoutMs.probe);
  });

  it("sends the source as base64 JSON, never as raw bytes", async () => {
    const { transport, requests } = scripted([CAPTURED_PROBE_200]);
    await httpMediaFunctions(BASE, transport).probe({ source: SOURCE });
    const body = JSON.parse(requests[0]!.body) as { source: { kind: string; base64: string } };
    assert.equal(body.source.kind, "bytes");
    assert.equal(body.source.base64, Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("returns the cut times the function reported", async () => {
    const { transport } = scripted([CAPTURED_CUTS_200]);
    const result = await httpMediaFunctions(BASE, transport).cuts({ source: SOURCE });
    assert.deepEqual(result.cutsMs, [1000, 2000]);
  });

  it("uses the configured scene score when the caller leaves it out", async () => {
    const { transport, requests } = scripted([CAPTURED_CUTS_200]);
    await httpMediaFunctions(BASE, transport).cuts({ source: SOURCE });
    const body = JSON.parse(requests[0]!.body) as { sceneScore: number };
    assert.equal(body.sceneScore, 0.3);
  });

  it("returns the loudness the function reported", async () => {
    const { transport } = scripted([CAPTURED_LOUDNESS_200]);
    const result = await httpMediaFunctions(BASE, transport).loudness({ source: SOURCE });
    assert.ok(result.integratedLufs !== null && result.integratedLufs < 0);
  });

  it("returns a frame whose PNG and declared size match, at the time asked", async () => {
    const { transport } = scripted([CAPTURED_FRAMES_200]);
    const result = await httpMediaFunctions(BASE, transport).frames({
      source: SOURCE,
      atMs: [1500],
      longSidePx: 768,
    });
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0]?.atMs, 1500);
    assert.equal(result.frames[0]?.width, 432);
    assert.equal(result.frames[0]?.height, 768);
    assert.deepEqual([...(result.frames[0]?.png.subarray(1, 4) ?? [])], [0x50, 0x4e, 0x47]);
  });
});

describe("httpMediaFunctions failures (typed, never a default)", () => {
  it("maps a rate limit to a retryable provider error with the function's message", async () => {
    const { transport } = scripted([SYNTHETIC_RATE_LIMIT_429]);
    const error = await rejection(httpMediaFunctions(BASE, transport).probe({ source: SOURCE }));
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, true);
    assert.match(error.message, /rate limited/);
  });

  it("maps a gateway timeout without a JSON body to a retryable provider error", async () => {
    const { transport } = scripted([SYNTHETIC_GATEWAY_TIMEOUT_504]);
    const error = await rejection(httpMediaFunctions(BASE, transport).loudness({ source: SOURCE }));
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, true);
  });

  it("maps a refused URL (policy) to a non-retryable invalid_input error", async () => {
    const { transport } = scripted([CAPTURED_URL_NOT_ALLOWED_400]);
    const error = await rejection(
      httpMediaFunctions(BASE, transport).probe({
        source: { kind: "url", url: "https://media.example.com/reel.mp4" },
      }),
    );
    assert.equal(error.kind, "invalid_input");
    assert.equal(error.retryable, false);
  });

  it("maps a frame past the end to invalid_input", async () => {
    const { transport } = scripted([CAPTURED_BEYOND_END_400]);
    const error = await rejection(
      httpMediaFunctions(BASE, transport).frames({ source: SOURCE, atMs: [2999] }),
    );
    assert.equal(error.kind, "invalid_input");
  });

  it("treats a transport that throws (unreachable, or its own timeout) as a retryable provider error", async () => {
    const { transport } = scripted([new Error("The operation was aborted due to timeout")]);
    const error = await rejection(httpMediaFunctions(BASE, transport).cuts({ source: SOURCE }));
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, true);
    assert.match(error.message, /did not answer/);
  });

  it("refuses a 200 whose body is not JSON, as a non-retryable provider error", async () => {
    const { transport } = scripted([{ status: 200, body: "<html>ok</html>" }]);
    const error = await rejection(httpMediaFunctions(BASE, transport).probe({ source: SOURCE }));
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, false);
  });

  it("refuses a 200 that does not match the result contract (cut times not ascending)", async () => {
    const { transport } = scripted([
      { status: 200, body: JSON.stringify({ cutsMs: [2000, 1000] }) },
    ]);
    const error = await rejection(httpMediaFunctions(BASE, transport).cuts({ source: SOURCE }));
    assert.equal(error.kind, "provider");
    assert.match(error.message, /invalid result/);
  });

  it("refuses a frame whose bytes are not a PNG of the declared size", async () => {
    const notPng = Buffer.from("not a png at all").toString("base64");
    const { transport } = scripted([
      {
        status: 200,
        body: JSON.stringify({
          frames: [{ atMs: 1500, width: 432, height: 768, pngBase64: notPng }],
        }),
      },
    ]);
    const error = await rejection(
      httpMediaFunctions(BASE, transport).frames({ source: SOURCE, atMs: [1500] }),
    );
    assert.equal(error.kind, "provider");
    assert.equal(error.retryable, false);
  });

  it("refuses an answer with the wrong number of frames rather than returning a shorter list", async () => {
    const { transport } = scripted([{ status: 200, body: JSON.stringify({ frames: [] }) }]);
    const error = await rejection(
      httpMediaFunctions(BASE, transport).frames({ source: SOURCE, atMs: [1500] }),
    );
    assert.equal(error.kind, "provider");
  });

  it("refuses inline bytes above the inline limit before any request is sent", async () => {
    const { transport, requests } = scripted([]);
    const big = {
      kind: "bytes" as const,
      bytes: { byteLength: 5 * 1024 * 1024 } as unknown as Uint8Array<ArrayBuffer>,
    };
    const error = await rejection(httpMediaFunctions(BASE, transport).probe({ source: big }));
    assert.equal(error.kind, "invalid_input");
    assert.equal(requests.length, 0);
  });
});

describe("httpMediaFunctions configuration", () => {
  it("refuses a base URL that is not a URL, as config", () => {
    assert.throws(
      () => httpMediaFunctions("not a url", scripted([]).transport),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
  });

  it("refuses a base URL with a scheme other than http or https", () => {
    assert.throws(
      () => httpMediaFunctions("ftp://media.test", scripted([]).transport),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
  });

  it("joins the function path to a base URL with a trailing slash", async () => {
    const { transport, requests } = scripted([CAPTURED_CUTS_200]);
    await httpMediaFunctions("https://media.test/fn/", transport).cuts({ source: SOURCE });
    assert.equal(requests[0]?.url, "https://media.test/fn/cuts");
  });
});
