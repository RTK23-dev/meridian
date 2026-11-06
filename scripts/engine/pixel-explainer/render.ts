// The agent-mode crew for a directed 8-bit film: checks the direction and the build, draws every frame with the code-drawn pixel engine
// (src/engine/compose/pixel/pixel-engine.js) in the local Chromium, synthesises the sound (sound.ts), encodes with ffmpeg, then measures
// the take against its direction (direction/take-check.ts). No provider call, no spend: the result is labelled "made in agent mode".
//
//   C="node --experimental-strip-types scripts/engine/pixel-explainer/render.ts"
//   $C --film film.json --build build.json --stills 0,2.5,9,14.5 --out dir     (stills only)
//   $C --film film.json --build build.json --out dir                           (video.mp4, report.json)
//   add --force to draw a film whose direction check blocks (for the directed-versus-described benchmark only)

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { pixelBuildSchema, type PixelBuild } from "../../../src/engine/compose/pixel/stage.ts";
import { directionFindings } from "../../../src/engine/direction/check.ts";
import { sfxCues } from "../../../src/engine/direction/compile.ts";
import { faithFindings } from "../../../src/engine/direction/faithful.ts";
import { directedFilmSchema, type DirectedFilm } from "../../../src/engine/direction/film.ts";
import { takeFindings } from "../../../src/engine/direction/take-check.ts";
import { filmTrack, writeWav } from "./sound.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(here, "../../../src/engine/compose/pixel/pixel-engine.js");
const BROWSER = process.env.PIXEL_BROWSER ?? "/opt/pw-browsers/chromium";

export type RenderReport = {
  filmId: string;
  label: "made in agent mode";
  direction: ReturnType<typeof directionFindings>;
  faith: ReturnType<typeof faithFindings>;
  take: ReturnType<typeof takeFindings>;
  measured: { frames: number; meanMotion: number; firstLastDistance: number; integratedLufs: number | null; truePeakDbfs: number | null };
};

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function loadFilm(path: string): DirectedFilm {
  return directedFilmSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function loadBuild(path: string): PixelBuild {
  return pixelBuildSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Mean absolute luma change per frame step, and the first-to-last distance (the engine's loopDistance), from the encoded file. With a
 * film, each step leaves out the band its shot keeps for the words, so a card cutting on is not counted as the picture changing (L4: the
 * moment is a change in the picture).
 */
export function measureMotion(video: string, film?: DirectedFilm): { motion: number[]; firstLast: number } {
  const w = 90, h = 160;
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 }).stdout;
  const frames = Math.floor(raw.length / (w * h));
  const motion: number[] = [];
  const bands = { top: [0, 0.34], centre: [0.33, 0.67], bottom: [0.66, 1] } as const;
  for (let f = 1; f < frames; f++) {
    const ms = (f / (film?.fps ?? 30)) * 1000;
    const shot = film?.shots.find((candidate) => ms >= candidate.startMs && ms < candidate.endMs) ?? film?.shots.at(-1);
    const [skipFrom, skipTo] = shot ? bands[shot.composition.emptyBand].map((v) => Math.round(v * h)) : [0, 0];
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      if (y >= (skipFrom ?? 0) && y < (skipTo ?? 0)) continue;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        sum += Math.abs((raw[f * w * h + i] ?? 0) - (raw[(f - 1) * w * h + i] ?? 0));
        n++;
      }
    }
    motion.push(sum / Math.max(1, n) / 255);
  }
  let d = 0;
  for (let i = 0; i < w * h; i++) d += Math.abs((raw[i] ?? 0) - (raw[(frames - 1) * w * h + i] ?? 0));
  return { motion, firstLast: d / (w * h) / 255 };
}

function loudness(file: string): { integratedLufs: number | null; truePeakDbfs: number | null } {
  const err = spawnSync("ffmpeg", ["-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const i = [...err.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop()?.[1];
  const p = [...err.matchAll(/Peak:\s+(-?[0-9.]+) dBFS/g)].pop()?.[1];
  return { integratedLufs: i ? Number(i) : null, truePeakDbfs: p ? Number(p) : null };
}

/** Two-pass loudnorm to -14 LUFS integrated, -1 dBTP: the study's measured master (12 of 12 between -14.4 and -14.1). */
function master(input: string, output: string): void {
  // Sound effects peak far above the bed; a gentle compressor and a limiter first, so the loudness target is reached in linear mode.
  const glued = output.replace(/\.wav$/, ".glued.wav");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", "acompressor=threshold=-20dB:ratio=3:attack=4:release=90:makeup=2,alimiter=limit=0.6:level=false", glued]);
  input = glued;
  const probe = spawnSync("ffmpeg", ["-i", input, "-af", "loudnorm=I=-14:TP=-1:LRA=9:print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const json = JSON.parse(probe.slice(probe.lastIndexOf("{"), probe.lastIndexOf("}") + 1)) as Record<string, string>;
  const filter = `loudnorm=I=-14:TP=-1:LRA=9:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`;
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", filter, "-ar", "48000", "-ac", "2", output]);
}

export async function render(film: DirectedFilm, build: PixelBuild, out: string, options: { stills?: number[]; scale?: number; force?: boolean } = {}): Promise<RenderReport | null> {
  mkdirSync(out, { recursive: true });
  const direction = directionFindings(film);
  const faith = faithFindings(film, build);
  const blocked = [...direction, ...faith].filter((finding) => finding.severity === "block");
  if (blocked.length > 0 && options.force !== true) {
    for (const finding of blocked) console.error(`blocked: ${finding.rule} at ${finding.at}: ${finding.message}`);
    throw new Error("the direction or the build blocks: fix it, or pass --force for a benchmark control");
  }
  const scale = options.scale ?? 4;
  const browser = await chromium.launch({ executablePath: BROWSER });
  const page = await browser.newPage({ viewport: { width: 180 * scale, height: 320 * scale }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.setContent(`<html><body style="margin:0;background:#000"><canvas id="c" width="${180 * scale}" height="${320 * scale}"></canvas></body></html>`);
  await page.addScriptTag({ path: ENGINE });
  await page.evaluate(([f, b]) => {
    const w = window as unknown as { PixelEngine: { create: (c: HTMLCanvasElement, f: unknown, b: unknown) => unknown }; __px: unknown };
    w.__px = w.PixelEngine.create(document.getElementById("c") as HTMLCanvasElement, f, b);
  }, [film, build] as const);
  const draw = (t: number) =>
    page.evaluate((s) => {
      const w = window as unknown as { __px: { renderAt: (s: number) => void } };
      w.__px.renderAt(s);
      return (document.getElementById("c") as HTMLCanvasElement).toDataURL("image/png");
    }, t);
  if (options.stills) {
    for (const t of options.stills) {
      const png = await draw(t);
      writeFileSync(join(out, `t${t.toFixed(2)}.png`), Buffer.from(png.split(",")[1] ?? "", "base64"));
    }
    await browser.close();
    return null;
  }
  const silent = join(out, "video.silent.mp4");
  const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(film.fps), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", silent], { stdio: ["pipe", "ignore", "inherit"] });
  const frames = Math.round((film.durationMs / 1000) * film.fps);
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    const png = Buffer.from((await draw(f / film.fps)).split(",")[1] ?? "", "base64");
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${frames}, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  ff.stdin.end();
  await new Promise<void>((r, j) => ff.on("close", (code) => (code === 0 ? r() : j(new Error(`ffmpeg ${code}`)))));
  await browser.close();

  const cues = sfxCues(film);
  writeWav(join(out, "track.raw.wav"), filmTrack(film, cues));
  master(join(out, "track.raw.wav"), join(out, "track.wav"));
  const video = join(out, "video.mp4");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", silent, "-i", join(out, "track.wav"), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", video]);

  const { motion, firstLast } = measureMotion(silent, film);
  const take = takeFindings(film, { fps: film.fps, motion, firstLastDistance: firstLast });
  const loud = loudness(video);
  const report: RenderReport = {
    filmId: film.filmId,
    label: "made in agent mode",
    direction,
    faith,
    take,
    measured: { frames, meanMotion: Number((motion.reduce((a, b) => a + b, 0) / motion.length).toFixed(4)), firstLastDistance: Number(firstLast.toFixed(4)), ...loud },
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "cues.json"), JSON.stringify(cues, null, 1));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const film = loadFilm(arg(args, "--film") ?? resolve(here, "../../../src/engine/direction/fixtures/microwave.film.json"));
  const build = loadBuild(arg(args, "--build") ?? resolve(here, "../../../src/engine/direction/fixtures/microwave.build.json"));
  const out = resolve(arg(args, "--out") ?? "pixel-out");
  const stills = arg(args, "--stills")?.split(",").map(Number);
  const scale = arg(args, "--scale") ? Number(arg(args, "--scale")) : undefined;
  const report = await render(film, build, out, { stills, scale, force: args.includes("--force") });
  if (report) {
    for (const f of [...report.direction, ...report.faith, ...report.take]) console.log(`${f.severity}: ${f.rule} at ${f.at}: ${f.message}`);
    console.log(JSON.stringify(report.measured));
    console.log(`wrote ${join(out, "video.mp4")} (made in agent mode)`);
  } else console.log(`stills written to ${out}`);
}
