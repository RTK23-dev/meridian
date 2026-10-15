// Test helper: generated clips for the picture measures (zoom and loop, Bible 8.1). Each clip is made by ffmpeg in the test process's
// fixture directory (media-fixture.ts) and is never committed. The clips have known answers:
//   punch            a 1.2x zoom-in about the centre at 1000 ms (frame 30 at 30 fps), with no cut
//   punch-offcentre  the same zoom-in, but the crop stays at the left edge, so the magnification is not about the centre
//   loop             a still picture whose brightness returns to its start at the end (the last frame matches the first)
//   drift            a slow zoom that does not come back: the last frame differs from the first
// Callers skip when ffmpeg is missing (ffmpegSkipReason), as the other media tests do.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fixtureDirectory } from "../../test/media-fixture.ts";

const execFileAsync = promisify(execFile);

export const CLIP = {
  width: 360,
  height: 640,
  fps: 30,
  durationMs: 2000,
  /** The punch-in: frame 30 at 30 fps is 1000 ms. */
  jumpMs: 1000,
  jumpScale: 1.2,
} as const;

export type ClipKind = "punch" | "punch-offcentre" | "loop" | "drift";

/** A textured still: smooth waves with a hard grid, so a scale is visible in the thumbnail. */
const TEXTURE = "128+90*sin(X/7)*sin(Y/11)+40*gt(mod(X+Y,53),26)";
const SIZE = `${CLIP.width}x${CLIP.height}`;
const STILL = `color=c=gray:s=${SIZE}:r=${CLIP.fps}:d=${CLIP.durationMs / 1000}`;

/** The filter graph of each clip. zoompan's `on` is the output frame number, so the zoom changes at a known frame. */
function clipArgs(kind: ClipKind, output: string): string[] {
  const jumpFrame = (CLIP.jumpMs * CLIP.fps) / 1000;
  const centred = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
  const graphs: Record<ClipKind, { input: string; filter?: string }> = {
    punch: {
      input: `${STILL},geq=lum='${TEXTURE}'`,
      filter: `zoompan=z='if(lt(on,${jumpFrame}),1,${CLIP.jumpScale})':${centred}:d=1:s=${SIZE}:fps=${CLIP.fps},format=yuv420p`,
    },
    "punch-offcentre": {
      input: `${STILL},geq=lum='${TEXTURE}'`,
      filter: `zoompan=z='if(lt(on,${jumpFrame}),1,${CLIP.jumpScale})':x='if(lt(on,${jumpFrame}),(iw-iw/zoom)/2,0)':y='(ih-ih/zoom)/2':d=1:s=${SIZE}:fps=${CLIP.fps},format=yuv420p`,
    },
    loop: {
      input: `${STILL},geq=lum='lum(X,Y)+25*sin(PI*T)'`,
    },
    drift: {
      input: `${STILL},geq=lum='${TEXTURE}'`,
      filter: `zoompan=z='1+0.3*on/${CLIP.fps * (CLIP.durationMs / 1000) - 1}':${centred}:d=1:s=${SIZE}:fps=${CLIP.fps},format=yuv420p`,
    },
  };
  const graph = graphs[kind];
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    graph.input,
    ...(graph.filter === undefined ? [] : ["-vf", graph.filter]),
    "-c:v",
    "libx264",
    "-crf",
    "14",
    "-preset",
    "ultrafast",
    output,
  ];
}

const clips = new Map<ClipKind, Promise<Uint8Array<ArrayBuffer>>>();

/** The bytes of one generated clip. Generated once per process. */
export function clipBytes(kind: ClipKind): Promise<Uint8Array<ArrayBuffer>> {
  let clip = clips.get(kind);
  if (clip === undefined) {
    clip = fixtureDirectory().then(async (dir) => {
      const output = join(dir, `picture-${kind}.mp4`);
      await execFileAsync("ffmpeg", clipArgs(kind, output), { maxBuffer: 1024 * 1024 });
      return new Uint8Array(await readFile(output));
    });
    clips.set(kind, clip);
  }
  return clip;
}
