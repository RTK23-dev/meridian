// The in-process media functions (inProcessMediaFunctions). The first describe runs real media through ffmpeg: it shows that the
// default scene score comes from configuration and that analyze_reference's frame plan runs end to end, and that every run removes
// its temporary directory, on success and on failure. The second needs no ffmpeg: a URL is refused before any handler runs, so the
// global fetch is never called.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { inProcessMediaFunctions } from "./local.ts";
import { framesAtCutsAndSamples } from "./frames.ts";
import { mediaConfig } from "./config.ts";
import { REEL, ffmpegSkipReason, reelPath } from "../test/media-fixture.ts";

const SKIP = ffmpegSkipReason() ?? false;

describe("inProcessMediaFunctions (ffmpeg in this process)", { skip: SKIP }, () => {
  it("identifies itself as the in-process implementation, so logs and manifests name it", () => {
    assert.equal(inProcessMediaFunctions().id, "in_process:ffmpeg");
  });

  it("finds the cuts with the default scene score from configuration", async () => {
    const source = {
      kind: "bytes" as const,
      bytes: new Uint8Array(await readFile(await reelPath())),
    };
    const result = await inProcessMediaFunctions().cuts({ source });
    assert.deepEqual(result.cutsMs, [...REEL.cutsMs]);
    assert.equal(mediaConfig.sceneCutScore.value, 0.3);
  });

  it("plans and samples the reel as Bible 6.2 says: a frame at each cut, then 2 per second", async () => {
    const source = {
      kind: "bytes" as const,
      bytes: new Uint8Array(await readFile(await reelPath())),
    };
    const functions = inProcessMediaFunctions();
    const { plan, frames } = await framesAtCutsAndSamples(functions, {
      source,
      durationMs: REEL.durationMs,
      cutsMs: [...REEL.cutsMs],
    });
    assert.deepEqual(plan.atMs, [250, 750, 1000, 1250, 1750, 2000, 2250, 2750]);
    assert.equal(plan.cutsCovered, true);
    assert.deepEqual(
      frames.map((frame) => frame.atMs),
      plan.atMs,
    );
    assert.ok(frames.every((frame) => frame.width === REEL.width && frame.height === REEL.height));
  });

  it("returns the probe and loudness through the same request types as production", async () => {
    const source = {
      kind: "bytes" as const,
      bytes: new Uint8Array(await readFile(await reelPath())),
    };
    const functions = inProcessMediaFunctions();
    const probe = await functions.probe({ source });
    const loudness = await functions.loudness({ source });
    assert.equal(probe.durationMs, REEL.durationMs);
    assert.ok(loudness.integratedLufs !== null);
  });

  it("removes its temporary directory on success and on failure, so a worker leaves nothing behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "in-process-test-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      const functions = inProcessMediaFunctions();
      const bytes = new Uint8Array(await readFile(await reelPath()));
      await functions.probe({ source: { kind: "bytes", bytes } });
      await assert.rejects(functions.probe({ source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) } }));
      assert.deepEqual(await readdir(dir), [], "no run leaves a workdir in the temporary directory");
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("inProcessMediaFunctions refuses URL inputs before any handler runs", () => {
  it("refuses a URL source for every function, and never calls the global fetch", async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("the global fetch must not be called by the in-process functions");
    }) as typeof fetch;
    try {
      const functions = inProcessMediaFunctions();
      const source = { kind: "url" as const, url: "https://media.example.com/reel.mp4" };
      const calls: Array<() => Promise<unknown>> = [
        () => functions.probe({ source }),
        () => functions.frames({ source, atMs: [500] }),
        () => functions.loudness({ source }),
        () => functions.cuts({ source }),
        () => functions.timeline({ source }),
        () => functions.picture({ source, cutsMs: [] }),
        () => functions.blackFrames({ source }),
        () => functions.flicker({ source }),
        () => functions.motion({ source }),
        () => functions.silence({ source }),
      ];
      for (const call of calls) {
        await assert.rejects(
          call(),
          (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
        );
      }
      assert.equal(fetches, 0, "no URL was fetched");
    } finally {
      globalThis.fetch = original;
    }
  });
});
