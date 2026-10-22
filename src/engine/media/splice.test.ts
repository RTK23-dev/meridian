import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildJoinArgs, buildSegmentArgs, joinListOf } from "../../../functions/ffmpeg/splice.ts";
import { spliceRequestSchema } from "../../../functions/ffmpeg/types.ts";
import { EngineError } from "../contracts/errors.ts";
import { spliceInProcess, spliceOverWire } from "./splice.ts";

const FFMPEG_AVAILABLE = spawnSync("ffmpeg", ["-version"]).status === 0;
const bytesSource = (bytes: Uint8Array<ArrayBuffer>) => ({ kind: "bytes" as const, bytes });

/** A three-second clip at the Meridian format's aspect, with an audio track, made by ffmpeg itself. */
function clipBytes(): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), "splice-test-"));
  try {
    const out = join(dir, "clip.mp4");
    const made = spawnSync(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=3:size=270x480:rate=25",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-y", out,
      ],
    );
    assert.equal(made.status, 0, String(made.stderr));
    return Uint8Array.from(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a splice segment ends after it starts, and a splice names at least one segment", () => {
  const ok = spliceRequestSchema.safeParse({ segments: [{ source: bytesSource(new Uint8Array([1])), inMs: 0, outMs: 500 }] });
  assert.equal(ok.success, true);
  assert.equal(spliceRequestSchema.safeParse({ segments: [{ source: bytesSource(new Uint8Array([1])), inMs: 500, outMs: 500 }] }).success, false);
  assert.equal(spliceRequestSchema.safeParse({ segments: [] }).success, false);
});

test("the segment command cuts the span and encodes to the shared 1080 by 1920, 30 fps format, with an optional audio map", () => {
  const args = buildSegmentArgs({ inputPath: "in.media", inMs: 1500, outMs: 4000, outputPath: "part-0.mp4" });
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), ["-ss", "1.500"]);
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "2.500"]);
  assert.ok(args.includes("0:a:0?"), "the audio map is optional");
  assert.ok(args.some((arg) => arg.includes("scale=1080:1920")), "every part has the shared frame");
  assert.equal(args.at(-1), "part-0.mp4");
});

test("the join is a stream copy of the parts, in order", () => {
  assert.deepEqual(buildJoinArgs({ listPath: "parts.txt", outputPath: "out.mp4" }).slice(-4), ["-movflags", "+faststart", "-y", "out.mp4"]);
  assert.equal(joinListOf(["part-0.mp4", "part-1.mp4"]), "file 'part-0.mp4'\nfile 'part-1.mp4'\n");
});

test("in process, a URL source is refused before anything runs", async () => {
  const editors = spliceInProcess();
  await assert.rejects(
    editors.splice({ segments: [{ source: { kind: "url", url: "https://example.com/a.mp4" }, inMs: 0, outMs: 500 }] }),
    EngineError,
  );
});

test("over HTTP, a 200 answer is checked against the result schema, and a wrong answer is refused", async () => {
  const requests: string[] = [];
  const post = (async (path: string, body: unknown, schema: { parse: (value: unknown) => unknown }) => {
    requests.push(path);
    assert.ok(JSON.stringify(body).includes("base64"), "the bytes travel as base64");
    return schema.parse({ mediaType: "video/mp4", base64: "AAAA", durationMs: 1000 });
  }) as never;
  const result = await spliceOverWire(post).splice({ segments: [{ source: bytesSource(new Uint8Array([1, 2, 3])), inMs: 0, outMs: 1000 }] });
  assert.equal(result.durationMs, 1000);
  assert.deepEqual(requests, ["/splice"]);
  const wrong = (async (_path: string, _body: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse({ mediaType: "video/webm", base64: "AAAA", durationMs: 1000 })) as never;
  await assert.rejects(spliceOverWire(wrong).splice({ segments: [{ source: bytesSource(new Uint8Array([1])), inMs: 0, outMs: 1000 }] }));
});

test("with real ffmpeg, two spans of a clip join into one MP4 whose measured length is the spans' total", { skip: !FFMPEG_AVAILABLE }, async () => {
  const clip = clipBytes();
  const { probeInProcess } = await import("./probe.ts");
  const probe = probeInProcess();
  const result = await spliceInProcess().splice({
    segments: [
      { source: bytesSource(clip), inMs: 0, outMs: 1000 },
      { source: bytesSource(clip), inMs: 1500, outMs: 2500 },
    ],
  });
  const output = Buffer.from(result.base64, "base64");
  assert.equal(output.subarray(4, 8).toString("ascii"), "ftyp", "the result is an MP4");
  assert.equal(result.durationMs, 2000);
  const measured = await probe({ source: bytesSource(output) });
  assert.ok(measured.durationMs !== null && Math.abs(measured.durationMs - 2000) < 150, `measured ${measured.durationMs} ms, expected about 2000 ms`);
  assert.ok(measured.width === 1080 && measured.height === 1920, "every output has the shared frame");
});
