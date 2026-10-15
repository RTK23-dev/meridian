// Test helper: generated clips for the detectors (Bible 6.7 step 1, 12.2, 12.3). Each clip is made by ffmpeg in the test process's
// fixture directory (media-fixture.ts) and is never committed. The clips have known answers:
//   black-gap   video only, 3 s at 30 fps: blue 0 to 1000 ms, black 1000 to 1500 ms, yellow 1500 to 3000 ms
//   flicker     video only, 2 s: the luma alternates 60, 200, 60, ... on every frame
//   steady      video only, 2 s: one flat grey, the same in every frame
//   pan         video only, 2 s: a textured picture that moves one step to the right each frame
//   tone-gap    3 s with a 1 kHz tone from 0 to 1000 ms and from 2000 to 3000 ms, silence between (video is flat grey)
//   no-audio    the same picture as steady, without an audio stream
// Callers skip when ffmpegSkipReason is set, as the other media tests do.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fixtureDirectory } from "../../test/media-fixture.ts";

const execFileAsync = promisify(execFile);

export const DETECTOR_CLIP = {
  width: 360,
  height: 640,
  fps: 30,
  /** black-gap: the black block runs from 1000 ms to 1500 ms. */
  blackStartMs: 1000,
  blackEndMs: 1500,
  /** tone-gap: the silence runs from 1000 ms to 2000 ms. */
  silenceStartMs: 1000,
  silenceEndMs: 2000,
} as const;

export type DetectorClipKind = "black-gap" | "flicker" | "steady" | "pan" | "tone-gap" | "no-audio";

const COMMON = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
const SIZE = `${DETECTOR_CLIP.width}x${DETECTOR_CLIP.height}`;
const RATE = String(DETECTOR_CLIP.fps);
const ENCODE = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-pix_fmt", "yuv420p"];

function colour(name: string, seconds: number): string[] {
  return ["-f", "lavfi", "-i", `color=c=${name}:s=${SIZE}:r=${RATE}:d=${seconds}`];
}

/** The ffmpeg arguments that make each clip. Pure, so a test can check them without running ffmpeg. */
export function clipArgs(kind: DetectorClipKind, output: string): string[] {
  switch (kind) {
    case "black-gap":
      return [
        ...COMMON,
        ...colour("0x2050c0", 1),
        ...colour("black", 0.5),
        ...colour("0xe0c020", 1.5),
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
        "-map",
        "[v]",
        ...ENCODE,
        output,
      ];
    case "flicker":
      return [
        ...COMMON,
        ...colour("gray", 2),
        "-vf",
        "geq=lum='if(eq(mod(N\\,2)\\,0)\\,60\\,200)':cb=128:cr=128",
        ...ENCODE,
        output,
      ];
    case "steady":
    case "no-audio":
      return [...COMMON, ...colour("gray", kind === "steady" ? 2 : 3), ...ENCODE, output];
    case "pan":
      return [
        ...COMMON,
        ...colour("gray", 2),
        "-vf",
        "geq=lum='128+90*sin((X+6*N)/9)*cos(Y/13)':cb=128:cr=128",
        ...ENCODE,
        output,
      ];
    case "tone-gap":
      return [
        ...COMMON,
        ...colour("gray", 3),
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000:duration=1",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=mono:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000:duration=1",
        "-filter_complex",
        "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]",
        "-map",
        "0:v",
        "-map",
        "[a]",
        ...ENCODE,
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        output,
      ];
  }
}

const clips = new Map<DetectorClipKind, Promise<Uint8Array<ArrayBuffer>>>();

/** The bytes of one generated clip. Generated once per process. */
export function detectorClipBytes(kind: DetectorClipKind): Promise<Uint8Array<ArrayBuffer>> {
  let clip = clips.get(kind);
  if (clip === undefined) {
    clip = fixtureDirectory().then(async (dir) => {
      const output = join(dir, `detector-${kind}.mp4`);
      await execFileAsync("ffmpeg", clipArgs(kind, output), { maxBuffer: 1024 * 1024 });
      return new Uint8Array(await readFile(output));
    });
    clips.set(kind, clip);
  }
  return clip;
}
