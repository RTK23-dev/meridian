// The client layer on real media, in-process (localMediaFunctions is for tests and CI only). It shows that the default
// scene score comes from configuration and that analyze_reference's frame plan runs end to end.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { localMediaFunctions } from "./local.ts";
import { framesAtCutsAndSamples } from "./frames.ts";
import { mediaConfig } from "./config.ts";
import { REEL, ffmpegSkipReason, reelPath } from "../test/media-fixture.ts";

const SKIP = ffmpegSkipReason() ?? false;

describe("localMediaFunctions (in-process, tests and CI only)", { skip: SKIP }, () => {
  it("identifies itself as the local implementation, so logs and manifests never mistake it for production", () => {
    assert.match(localMediaFunctions.id, /tests and CI only/);
  });

  it("finds the cuts with the default scene score from configuration", async () => {
    const source = {
      kind: "bytes" as const,
      bytes: new Uint8Array(await readFile(await reelPath())),
    };
    const result = await localMediaFunctions.cuts({ source });
    assert.deepEqual(result.cutsMs, [...REEL.cutsMs]);
    assert.equal(mediaConfig.sceneCutScore.value, 0.3);
  });

  it("plans and samples the reel as Bible 6.2 says: a frame at each cut, then 2 per second", async () => {
    const source = {
      kind: "bytes" as const,
      bytes: new Uint8Array(await readFile(await reelPath())),
    };
    const { plan, frames } = await framesAtCutsAndSamples(localMediaFunctions, {
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

  it("returns the probe, loudness and frames through the same request types as production", async () => {
    const source = {
      kind: "bytes" as const,
      bytes: new Uint8Array(await readFile(await reelPath())),
    };
    const probe = await localMediaFunctions.probe({ source });
    const loudness = await localMediaFunctions.loudness({ source });
    assert.equal(probe.durationMs, REEL.durationMs);
    assert.ok(loudness.integratedLufs !== null);
  });
});
