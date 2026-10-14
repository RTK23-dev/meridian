// Golden-frame harness (Bible 17.3, components level). Local HyperFrames rendering is allowed only here, for tests:
// production renders go to the cloud (Bible principle 8). Each component fixture becomes a one-clip composition, is
// rendered with the HyperFrames CLI from node_modules, and frames are pulled out with ffmpeg and compared to stored PNGs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { EditDecisionList } from "../../../contracts/index.ts";
import { fixtureId, styleKitFixture } from "../../../contracts/fixtures/index.ts";
import { compile } from "../../compiler.ts";
import type { ComponentDefinition, ComponentFixture } from "../../library.ts";
import { parseStyleKit } from "../../styleKit.ts";

/** The HyperFrames CLI from node_modules (golden directory, up through compose, engine and src to the repo root). */
export const CLI_PATH = fileURLToPath(new URL("../../../../../node_modules/hyperframes/bin/hyperframes.mjs", import.meta.url));

/** Pixels whose channels differ by more than this count as different. */
export const CHANNEL_TOLERANCE = 16;

/** Pass when fewer than this share of pixels differ (Bible 17.3: under 1%). */
export const MAX_DIFF_RATIO = 0.01;

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;

/** The kit used for golden frames: the contracts fixture kit with bundled fonts, so no font is fetched at render. */
export const goldenKit = parseStyleKit({
  ...styleKitFixture,
  fonts: { display: "Inter", body: "Inter", captions: "Inter" },
});

/** Where the golden PNG for one component fixture frame lives. */
export function goldenPath(component: ComponentDefinition, fixture: ComponentFixture, frameMs: number): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "components", component.name, "golden", `${fixture.name}@${frameMs}ms.png`);
}

export function goldenExists(component: ComponentDefinition, fixture: ComponentFixture, frameMs: number): boolean {
  return existsSync(goldenPath(component, fixture, frameMs));
}

/** A silent 8 kHz mono WAV of the given length. It stands in for the voice track in golden compositions. */
export function silentWav(durationMs: number): Uint8Array {
  const sampleRate = 8000;
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
}

/**
 * Disc colours for the placeholder media, by the file's base name (the URI's last path segment without extension). The
 * hero colour is the first and the default, so the product.card golden frame is unchanged. Placeholders are plain
 * gradients and solid colours: never product or person photography, and never shipped to a customer.
 */
const PLACEHOLDER_PALETTE: Record<string, readonly [number, number, number]> = {
  hero: [230, 90, 40],
  before: [200, 60, 60],
  after: [60, 190, 110],
  base: [40, 140, 230],
  presenter: [240, 180, 40],
};
const DEFAULT_PALETTE = PLACEHOLDER_PALETTE.hero;

/** The base name of a media URI: store://golden/after.webm gives "after". */
export function placeholderName(uri: string): string {
  const file = uri.split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  return dot === -1 ? file : file.slice(0, dot);
}

function paletteFor(name: string): readonly [number, number, number] {
  return Object.prototype.hasOwnProperty.call(PLACEHOLDER_PALETTE, name) ? PLACEHOLDER_PALETTE[name] : DEFAULT_PALETTE;
}

/**
 * A plain test image: a gradient with a disc, in the colour for its name. It stands in for product photography, people
 * and item images in golden frames. It is labelled in each fixture as a placeholder.
 */
export function placeholderPng(name: string): Uint8Array {
  const [discR, discG, discB] = paletteFor(name);
  const png = new PNG({ width: 960, height: 480 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const inDisc = (x - 480) ** 2 + (y - 240) ** 2 < 150 ** 2;
      png.data[i] = inDisc ? discR : 40 + Math.round((x / png.width) * 80);
      png.data[i + 1] = inDisc ? discG : 80 + Math.round((y / png.height) * 60);
      png.data[i + 2] = inDisc ? discB : 160;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** The hero placeholder for product.card (the original golden image). */
export function placeholderHeroPng(): Uint8Array {
  return placeholderPng("hero");
}

/**
 * Writes a short solid-colour VP8 clip in the colour for its name, as a placeholder for a video slot. Golden renders
 * use it so a component's own video path is exercised. Needs ffmpeg (FFMPEG_PATH, or ffmpeg on the PATH).
 */
export function writePlaceholderVideo(target: string, name: string): void {
  const [r, g, b] = paletteFor(name);
  const hex = [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const run = spawnSync(
    ffmpeg,
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${hex}:s=216x384:r=30:d=6`,
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "40k",
      "-an",
      target,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (run.error || run.status !== 0 || !existsSync(target)) {
    throw new Error(`ffmpeg could not write the video placeholder ${name}: ${run.error?.message ?? run.stderr}`);
  }
}

/** The one-clip EDL that holds a component fixture for its whole duration. */
export function fixtureEdl(component: ComponentDefinition, fixture: ComponentFixture): EditDecisionList {
  return {
    schema: "meridian.edl/v1",
    edlId: fixtureId("edl_", 3),
    requestId: fixtureId("req_", 1),
    durationMs: fixture.durationMs,
    fps: 30,
    width: 1080,
    height: 1920,
    tracks: [
      {
        layer: "graphics",
        clips: [
          {
            clipId: "golden_clip",
            startMs: 0,
            endMs: fixture.durationMs,
            component: component.name,
            props: fixture.props,
          },
        ],
      },
    ],
    audio: {
      voice: { uri: "store://golden/silence.wav", startMs: 0, endMs: fixture.durationMs, gainDb: 0 },
      sfx: [],
      masterLufs: -14,
    },
    effects: [],
    seed: 1,
  };
}

export type BuiltHarness = { dir: string };

/**
 * Write a harness composition for one component fixture into a fresh temporary directory.
 * mode "render" writes real placeholders (a PNG, a generated video, a silent WAV) for the golden renders. mode "lint"
 * writes empty files for video, which the static linter needs only to exist, so the lint tests need no ffmpeg.
 */
export function buildHarness(
  component: ComponentDefinition,
  fixture: ComponentFixture,
  mode: "render" | "lint" = "render",
): BuiltHarness {
  const dir = mkdtempSync(join(tmpdir(), `meridian-golden-${component.name}-${fixture.name}-`));
  const result = compile(fixtureEdl(component, fixture), goldenKit, { [component.name]: component });
  for (const file of result.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  for (const asset of result.assets) {
    const target = join(dir, asset.path);
    mkdirSync(dirname(target), { recursive: true });
    const name = placeholderName(asset.uri);
    if (asset.kind === "audio") {
      writeFileSync(target, silentWav(fixture.durationMs));
    } else if (asset.kind === "image") {
      writeFileSync(target, placeholderPng(name));
    } else if (mode === "lint") {
      writeFileSync(target, Buffer.alloc(0));
    } else {
      writePlaceholderVideo(target, name);
    }
  }
  return { dir };
}

export type RenderOutcome = { ok: true; mp4: string } | { ok: false; reason: string };

/**
 * Render a harness locally with the HyperFrames CLI. The browser comes from HYPERFRAMES_BROWSER_PATH (or the
 * PRODUCER_HEADLESS_SHELL_PATH alias); without one, the CLI looks for its own managed browser.
 */
export function renderHarnessLocally(built: BuiltHarness): RenderOutcome {
  const mp4 = join(built.dir, "render.mp4");
  const run = spawnSync(process.execPath, [CLI_PATH, "render", "-o", mp4], {
    cwd: built.dir,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) {
    return { ok: false, reason: `could not start the HyperFrames CLI: ${run.error.message}` };
  }
  if (run.status !== 0 || !existsSync(mp4)) {
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(-12).join("\n");
    return { ok: false, reason: `hyperframes render exited ${run.status}:\n${tail}` };
  }
  return { ok: true, mp4 };
}

/** Pull one frame out of the MP4 as PNG bytes, using ffmpeg (FFMPEG_PATH, or ffmpeg on the PATH). */
export function extractFrame(mp4: string, frameMs: number, workDir: string): Uint8Array {
  const out = join(workDir, `frame-${frameMs}.png`);
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const run = spawnSync(
    ffmpeg,
    ["-y", "-loglevel", "error", "-i", mp4, "-ss", (frameMs / 1000).toFixed(3), "-frames:v", "1", out],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (run.error || run.status !== 0 || !existsSync(out)) {
    throw new Error(`ffmpeg could not extract frame ${frameMs} ms: ${run.error?.message ?? run.stderr}`);
  }
  return new Uint8Array(readFileSync(out));
}

export type FrameComparison = { pass: boolean; diffRatio: number; width: number; height: number; reason?: string };

/** Compare two PNGs pixel by pixel. Fails on a size mismatch, and when too many pixels differ. */
export function comparePng(actualBytes: Uint8Array, goldenBytes: Uint8Array): FrameComparison {
  const actual = PNG.sync.read(Buffer.from(actualBytes));
  const golden = PNG.sync.read(Buffer.from(goldenBytes));
  if (actual.width !== golden.width || actual.height !== golden.height) {
    return {
      pass: false,
      diffRatio: 1,
      width: actual.width,
      height: actual.height,
      reason: `size ${actual.width}x${actual.height} differs from golden ${golden.width}x${golden.height}`,
    };
  }
  let different = 0;
  const total = actual.width * actual.height;
  for (let i = 0; i < actual.data.length; i += 4) {
    const dr = Math.abs(actual.data[i] - golden.data[i]);
    const dg = Math.abs(actual.data[i + 1] - golden.data[i + 1]);
    const db = Math.abs(actual.data[i + 2] - golden.data[i + 2]);
    if (dr > CHANNEL_TOLERANCE || dg > CHANNEL_TOLERANCE || db > CHANNEL_TOLERANCE) {
      different += 1;
    }
  }
  const diffRatio = different / total;
  return { pass: diffRatio < MAX_DIFF_RATIO, diffRatio, width: actual.width, height: actual.height };
}

export function removeHarness(built: BuiltHarness): void {
  rmSync(built.dir, { recursive: true, force: true });
}
