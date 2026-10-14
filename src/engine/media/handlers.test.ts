// The handlers run for real: ffmpeg and ffprobe on generated media (see src/engine/test/media-fixture.ts). They are
// skipped with a visible reason when ffmpeg is not installed (set MERIDIAN_REQUIRE_FFMPEG=1 to fail instead).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { EngineError } from "../contracts/errors.ts";
import { run as runCuts } from "../../../functions/ffmpeg/cuts.ts";
import { run as runFrames } from "../../../functions/ffmpeg/frames.ts";
import { run as runLoudness } from "../../../functions/ffmpeg/loudness.ts";
import { run as runProbe } from "../../../functions/ffmpeg/probe.ts";
import { runTool } from "../../../functions/ffmpeg/exec.ts";
import {
  REEL,
  TONE,
  ffmpegSkipReason,
  reelPath,
  tonePath,
  videoOnlyPath,
} from "../test/media-fixture.ts";

const SKIP = ffmpegSkipReason() ?? false;
const FRAME_MS = 1000 / REEL.fps;

async function bytesSource(path: string) {
  return { kind: "bytes" as const, bytes: new Uint8Array(await readFile(path)) };
}

/** Mean colour of the central part of a PNG, as [r, g, b]. */
function meanColour(png: Uint8Array): [number, number, number] {
  const decoded = PNG.sync.read(Buffer.from(png));
  const sums = [0, 0, 0];
  let count = 0;
  for (let y = Math.floor(decoded.height * 0.3); y < decoded.height * 0.7; y += 8) {
    for (let x = Math.floor(decoded.width * 0.3); x < decoded.width * 0.7; x += 8) {
      const i = (y * decoded.width + x) * 4;
      sums[0]! += decoded.data[i]!;
      sums[1]! += decoded.data[i + 1]!;
      sums[2]! += decoded.data[i + 2]!;
      count += 1;
    }
  }
  return [sums[0]! / count, sums[1]! / count, sums[2]! / count] as [number, number, number];
}

function near(actual: readonly number[], expected: readonly number[], tolerance: number): boolean {
  return actual.every((value, i) => Math.abs(value - expected[i]!) <= tolerance);
}

describe("probe handler on the generated reel", { skip: SKIP }, () => {
  it("reports the generated properties exactly", async () => {
    const reel = await reelPath();
    const result = await runProbe({ source: await bytesSource(reel) });
    assert.equal(result.container, "mov,mp4,m4a,3gp,3g2,mj2");
    assert.equal(result.videoCodec, "h264");
    assert.equal(result.audioCodec, "aac");
    assert.equal(result.width, REEL.width);
    assert.equal(result.height, REEL.height);
    assert.deepEqual(result.fps, { num: 30, den: 1, value: 30 });
    assert.equal(result.durationMs, REEL.durationMs);
    assert.equal(result.audioPresent, true);
    assert.equal(result.bytes, (await readFile(reel)).byteLength);
  });

  it("reads the same result from a URL as from bytes", async () => {
    const reel = await reelPath();
    const bytes = await readFile(reel);
    const server = await serve(bytes);
    try {
      const fromUrl = await runProbe(
        { source: { kind: "url", url: server.url } },
        { urlPolicy: () => true },
      );
      const fromBytes = await runProbe({ source: { kind: "bytes", bytes: new Uint8Array(bytes) } });
      assert.deepEqual(fromUrl, fromBytes);
    } finally {
      await server.close();
    }
  });

  it("refuses a plain-http URL under the default policy, before any fetch", async () => {
    await assert.rejects(
      runProbe({ source: { kind: "url", url: "http://127.0.0.1:9/reel.mp4" } }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("refuses bytes that are not media as invalid input, without the temporary path in the message", async () => {
    await assert.rejects(
      runProbe({ source: { kind: "bytes", bytes: new Uint8Array(1000).fill(7) } }),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.equal(error.kind, "invalid_input");
        assert.doesNotMatch(error.message, /meridian-ffmpeg-/);
        return true;
      },
    );
  });

  it("reports no audio for a video-only file and fails nothing silently", async () => {
    const result = await runProbe({ source: await bytesSource(await videoOnlyPath()) });
    assert.equal(result.audioPresent, false);
    assert.equal(result.audioCodec, null);
    assert.equal(result.videoCodec, "h264");
  });
});

describe("cuts handler on the generated reel", { skip: SKIP }, () => {
  it("finds the two hard colour cuts within 2 frames of their known times (Bible 6.2 test)", async () => {
    const result = await runCuts({ source: await bytesSource(await reelPath()), sceneScore: 0.3 });
    assert.equal(result.cutsMs.length, REEL.cutsMs.length);
    REEL.cutsMs.forEach((expected, i) => {
      const found = result.cutsMs[i]!;
      assert.ok(
        Math.abs(found - expected) <= 2 * FRAME_MS,
        `cut ${found} ms is not within 2 frames of ${expected} ms`,
      );
    });
  });

  it("finds no cut above a threshold higher than every cut score", async () => {
    const result = await runCuts({ source: await bytesSource(await reelPath()), sceneScore: 0.95 });
    assert.deepEqual(result.cutsMs, []);
  });

  it("finds no cut in a single-colour video (one shot)", async () => {
    const result = await runCuts({
      source: await bytesSource(await videoOnlyPath()),
      sceneScore: 0.3,
    });
    assert.deepEqual(result.cutsMs, []);
  });
});

describe("loudness handler", { skip: SKIP }, () => {
  it("measures a 1 kHz tone at amplitude 0.1 within 0.5 LU of its known level (Bible 6.11)", async () => {
    const result = await runLoudness({ source: await bytesSource(await tonePath()) });
    assert.ok(result.integratedLufs !== null);
    assert.ok(
      Math.abs(result.integratedLufs - TONE.integratedLufs) <= 0.5,
      `integrated ${result.integratedLufs} LUFS is not within 0.5 LU of ${TONE.integratedLufs}`,
    );
    assert.ok(result.truePeakDbtp !== null);
    assert.ok(Math.abs(result.truePeakDbtp - TONE.truePeakDbtp) <= 0.5);
    assert.ok(result.loudnessRangeLu !== null && result.loudnessRangeLu >= 0);
  });

  it("measures the reel's AAC audio", async () => {
    const result = await runLoudness({ source: await bytesSource(await reelPath()) });
    assert.ok(result.integratedLufs !== null && result.integratedLufs < 0);
  });

  it("refuses a video with no audio stream as invalid input, never as a zero", async () => {
    await assert.rejects(
      runLoudness({ source: await bytesSource(await videoOnlyPath()) }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("frames handler on the generated reel", { skip: SKIP }, () => {
  it("returns valid PNGs at the asked times, and the colours show the right segment at each time", async () => {
    const result = await runFrames({
      source: await bytesSource(await reelPath()),
      atMs: [500, 1500, 2500],
    });
    assert.deepEqual(
      result.frames.map((frame) => frame.atMs),
      [500, 1500, 2500],
    );
    for (const frame of result.frames) {
      assert.equal(frame.width, REEL.width);
      assert.equal(frame.height, REEL.height);
      assert.deepEqual(
        [...frame.png.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    }
    assert.ok(
      near(meanColour(result.frames[1]!.png), REEL.blueRgb, 14),
      "1500 ms is in the blue block",
    );
    assert.ok(
      near(meanColour(result.frames[2]!.png), REEL.yellowRgb, 14),
      "2500 ms is in the yellow block",
    );
  });

  it("scales the frames down to a long side when asked", async () => {
    const result = await runFrames({
      source: await bytesSource(await reelPath()),
      atMs: [1500],
      longSidePx: 768,
    });
    assert.equal(result.frames[0]?.width, 432);
    assert.equal(result.frames[0]?.height, 768);
  });

  it("refuses a time at or past the last frame as invalid input", async () => {
    await assert.rejects(
      runFrames({ source: await bytesSource(await reelPath()), atMs: [2999] }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("refuses frames from audio-only media as invalid input", async () => {
    await assert.rejects(
      runFrames({ source: await bytesSource(await tonePath()), atMs: [0] }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("refuses a scale request on audio-only media as invalid input", async () => {
    await assert.rejects(
      runFrames({ source: await bytesSource(await tonePath()), atMs: [0], longSidePx: 768 }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("tool runner", { skip: SKIP }, () => {
  it("reports a timeout as a retryable provider error", async () => {
    await assert.rejects(
      runTool("ffprobe", ["-version"], { timeoutMs: 1, stage: "test" }),
      (error: unknown) =>
        error instanceof EngineError && error.kind === "provider" && error.retryable === true,
    );
  });

  it("reports a missing binary as config, not as a provider failure", async () => {
    await assert.rejects(
      runTool("ffprobe", ["-version"], {
        timeoutMs: 5000,
        stage: "test",
        paths: { ffprobe: "/nonexistent/ffprobe" },
      }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
  });
});

/** A local HTTP server that serves one body on 127.0.0.1, for the URL source test. */
async function serve(body: Uint8Array): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/reel.mp4`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
