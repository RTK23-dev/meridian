import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { probeInProcess } from "../media/probe.ts";
import { spliceInProcess } from "../media/splice.ts";
import { runSplice, unbuiltWindowRender, type SpliceRunPorts } from "./splice-run.ts";
import { splicePlanOf } from "./splice.ts";

const FFMPEG_AVAILABLE = spawnSync("ffmpeg", ["-version"]).status === 0;

/** A clip of the given length, at the Meridian format's aspect, with an audio track, made by ffmpeg. */
function clipBytes(seconds: number): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), "splice-run-test-"));
  try {
    const out = join(dir, "clip.mp4");
    const made = spawnSync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=270x480:rate=25`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", out,
    ]);
    assert.equal(made.status, 0, String(made.stderr));
    return Uint8Array.from(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function portsWith(overrides: Partial<SpliceRunPorts> & { calls?: string[] } = {}): SpliceRunPorts {
  const calls = overrides.calls ?? [];
  return {
    renderWindow: async () => {
      calls.push("renderWindow");
      return { status: "rendered", bytes: new Uint8Array([0]) };
    },
    readMaster: async () => {
      calls.push("readMaster");
      return new Uint8Array([0]);
    },
    storeMaster: async () => {
      calls.push("storeMaster");
      return "engine/org/req/master.mp4";
    },
    editors: {
      splice: async () => {
        calls.push("splice");
        throw new Error("unused in this test");
      },
    },
    ...overrides,
  };
}

const SPLICE = splicePlanOf({ totalMs: 3000, changed: [{ startMs: 1000, endMs: 2000 }], beatBoundariesMs: [1000, 2000] });

test("a full plan renders the whole video and runs nothing here", async () => {
  const calls: string[] = [];
  const full = splicePlanOf({ totalMs: 3000, changed: [{ startMs: 0, endMs: 3000 }], beatBoundariesMs: [] });
  const outcome = await runSplice(full, portsWith({ calls }));
  assert.equal(outcome.status, "full");
  assert.deepEqual(calls, []);
});

test("an unbuilt window render stops the splice as not connected, and nothing is joined or stored", async () => {
  const calls: string[] = [];
  const outcome = await runSplice(SPLICE, portsWith({ calls, renderWindow: unbuiltWindowRender() }));
  assert.equal(outcome.status, "not_connected");
  assert.match(outcome.status === "not_connected" ? outcome.reason : "", /window render is not built/);
  assert.deepEqual(calls, []);
});

test("a window render that fails stops the splice as failed, and nothing is joined or stored", async () => {
  const calls: string[] = [];
  const outcome = await runSplice(SPLICE, portsWith({ calls, renderWindow: async () => ({ status: "failed", reason: "the renderer refused" }) }));
  assert.deepEqual(outcome, { status: "failed", reason: "the renderer refused" });
  assert.deepEqual(calls, []);
});

test("a join that throws stores no master and reports the reason", async () => {
  const calls: string[] = [];
  const outcome = await runSplice(
    SPLICE,
    portsWith({
      calls,
      editors: { splice: async () => { throw new EngineError("provider", "ffmpeg stopped", { stage: "media.splice" }); } },
    }),
  );
  assert.equal(outcome.status, "failed");
  assert.ok(!calls.includes("storeMaster"), "nothing is stored when the join fails");
});

test("with real ffmpeg, the kept spans and the window join into a master whose measured length is the whole video", { skip: !FFMPEG_AVAILABLE }, async () => {
  const master = clipBytes(3);
  const window = clipBytes(1);
  let stored: Uint8Array<ArrayBuffer> | null = null;
  const outcome = await runSplice(SPLICE, {
    renderWindow: async () => ({ status: "rendered", bytes: window }),
    readMaster: async () => master,
    storeMaster: async (bytes) => {
      stored = bytes;
      return "engine/org/req/master.mp4";
    },
    editors: spliceInProcess(),
  });
  assert.equal(outcome.status, "spliced");
  assert.equal(outcome.status === "spliced" ? outcome.segments : 0, 3, "keep, window, keep");
  assert.ok(stored !== null, "the joined master is stored");
  const measured = await probeInProcess()({ source: { kind: "bytes", bytes: stored ?? new Uint8Array(0) } });
  assert.ok(measured.durationMs !== null && Math.abs(measured.durationMs - 3000) < 200, `measured ${measured.durationMs} ms`);
});
