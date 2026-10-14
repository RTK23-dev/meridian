// Test helper: deterministic media generated with ffmpeg, written to a temporary directory for the test process.
// The reel is 3 s, 1080 x 1920, 30 fps H.264 with mono AAC: testsrc2 for 0 to 1 s, then two solid colour cuts at exactly
// 1000 ms and 2000 ms. It is about 350 KB, above the 300 KB cache limit, so it is generated per run and never committed.
// Tests call ffmpegSkipReason() and pass the result as the skip option, so a missing ffmpeg is visible in the test
// report. The environment switch that makes a missing ffmpeg fail the run is read in ffmpeg-required.test.ts, not here.

import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REEL = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 3000,
  /** Hard colour cuts at these exact times (frame 30 and frame 60 at 30 fps). */
  cutsMs: [1000, 2000],
  /** Colours of the two solid segments, for checking frames at the asked times. */
  blueRgb: [0x20, 0x50, 0xc0],
  yellowRgb: [0xe0, 0xc0, 0x20],
} as const;

export const TONE = {
  hz: 1000,
  amplitude: 0.1,
  durationMs: 3000,
  /** A mono 1 kHz sine of amplitude 0.1: 10*log10(0.1^2/2) - 0.691 = -23.70 LUFS unweighted; the K-weighting filter at
   * 1 kHz adds about 0.7 dB, so BS.1770 measures about -23.0 LUFS. */
  integratedLufs: -23.0,
  truePeakDbtp: -20.0,
} as const;

/** Why ffmpeg-dependent tests cannot run here, or null when ffmpeg and ffprobe are installed. */
export function ffmpegSkipReason(): string | null {
  const ok = ["ffmpeg", "ffprobe"].every(
    (tool) => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0,
  );
  if (ok) {
    return null;
  }
  return "ffmpeg and ffprobe are not installed on PATH; these tests need them (CI sets MERIDIAN_REQUIRE_FFMPEG=1 to fail the run)";
}

let directory: Promise<string> | undefined;

/** One temporary directory per test process, removed when the process exits. */
export function fixtureDirectory(): Promise<string> {
  directory ??= mkdtemp(join(tmpdir(), "meridian-media-fixture-")).then((dir) => {
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    return dir;
  });
  return directory;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 1024 * 1024,
  });
}

let reel: Promise<string> | undefined;

/** Path of the generated reel (see the header). Generated once per process. */
export function reelPath(): Promise<string> {
  reel ??= fixtureDirectory().then(async (dir) => {
    const path = join(dir, "reel.mp4");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${REEL.width}x${REEL.height}:rate=${REEL.fps}:duration=1`,
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${hex(REEL.blueRgb)}:size=${REEL.width}x${REEL.height}:rate=${REEL.fps}:duration=1`,
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${hex(REEL.yellowRgb)}:size=${REEL.width}x${REEL.height}:rate=${REEL.fps}:duration=1`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:sample_rate=48000:duration=3`,
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      "-map",
      "3:a",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "30",
      "-r",
      String(REEL.fps),
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-t",
      String(REEL.durationMs / 1000),
      path,
    ]);
    return path;
  });
  return reel;
}

let tone: Promise<string> | undefined;

/** Path of a 3 s mono 1 kHz tone at amplitude 0.1, as WAV (no codec loss). Generated once per process. */
export function tonePath(): Promise<string> {
  tone ??= fixtureDirectory().then(async (dir) => {
    const path = join(dir, "tone.wav");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=${TONE.amplitude}*sin(2*PI*${TONE.hz}*t):s=48000:d=${TONE.durationMs / 1000}`,
      "-c:a",
      "pcm_s16le",
      path,
    ]);
    return path;
  });
  return tone;
}

let videoOnly: Promise<string> | undefined;

/** Path of a 1 s video with no audio stream (the reel's first colour block). Generated once per process. */
export function videoOnlyPath(): Promise<string> {
  videoOnly ??= fixtureDirectory().then(async (dir) => {
    const path = join(dir, "video-only.mp4");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${hex(REEL.blueRgb)}:size=${REEL.width}x${REEL.height}:rate=${REEL.fps}:duration=1`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    return path;
  });
  return videoOnly;
}

/** A directory the caller removes. Used by tests that need their own files. */
export async function scratchDirectory(
  prefix: string,
): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

function hex(rgb: readonly number[]): string {
  return rgb.map((value) => value.toString(16).padStart(2, "0")).join("");
}
