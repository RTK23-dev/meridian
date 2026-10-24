// The take checks' media detectors in production (Bible 6.7 step 1). check_take reads a take's black or frozen frames, flicker and motion
// from the detectors of the production composition. Before this wiring, the composition built no detectors, so every take reported those
// measures as missing evidence and escalated, even with the media functions connected. The clip here is a real two-second file made with
// ffmpeg at run time, and the measures are read by the same function check_take calls.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createGateway } from "../gateway/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { takeMeasurementsFromDetectors } from "./gate-measures.ts";
import { notConnectedMediaLinks } from "./media-link.ts";
import { productionComposition } from "./runtime.ts";
import { fakeObjects, keySource, recordedTransport } from "./test/harness.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

const WS = "ws_take_measures";
const BRAND = "brand_take_measures";

function takeClipBytes(): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), "take-clip-"));
  const out = join(dir, "take.mp4");
  try {
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=360x640:rate=10",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
});

after(async () => {
  await db.close();
});

test("the production take detectors measure a real take: black or frozen frames, flicker and motion are numbers, not missing evidence", async () => {
  const transport = recordedTransport({});
  const gateway = createGateway({ transport: transport.transport, credentials: keySource({}) });
  const composition = productionComposition(db.sql as unknown as Sql, {
    gateway,
    mediaLinks: notConnectedMediaLinks("this test has no media link signer"),
    objects: fakeObjects(),
    mediaFunctionsMode: "in_process",
    mediaFunctionsBaseUrl: null,
  });
  const detectors = composition.shotPorts?.detectors;
  assert.ok(detectors, "the production shot ports give check_take its media detectors");

  const bytes = takeClipBytes();
  const measures = await takeMeasurementsFromDetectors(detectors, { take: { durationMs: 2000 }, bytes });
  assert.equal(typeof measures.blackOrFrozenRunFrames, "number", "the longest black or frozen run is measured on the take's bytes");
  assert.equal(typeof measures.flickerScore, "number", "the flicker score is measured on the take's bytes");
  assert.equal(typeof measures.meanMotion, "number", "the mean motion is measured on the take's bytes");
  assert.deepEqual(transport.requests, [], "the measures are local: no provider is called");
});
