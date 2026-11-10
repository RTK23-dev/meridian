// The agent-mode renderer of the code-drawn styles (isometric, paper-cut, line diagram, stacked chart): checks the scene spec, draws every
// frame with the style's module (src/engine/compose/styles/<style>.js) in the local Chromium, synthesises the sound (sound.ts), masters it
// to -14 LUFS, encodes 1080 x 1920 at 30 fps, and measures the take (length, loudness, how close the last frame is to the first). No provider
// call, no spend: the result is labelled "made in agent mode".
//
//   R="node --experimental-strip-types scripts/engine/applied-styles/render.ts"
//   $R --spec spec.json --stills 0,3,8 --out dir     (stills only)
//   $R --spec spec.json --out dir                    (video.mp4, report.json)

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { codedStyleSpecSchema, STYLE_MODULES, type CodedStyleSpec } from "../../../src/engine/compose/styles/specs.ts";
import { writeWav } from "../pixel-explainer/sound.ts";
import { styleTrack, type StyleBed, type StyleCue } from "./sound.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(here, "../../../src/engine/compose/styles");
const BROWSER = process.env.STYLES_BROWSER ?? "/opt/pw-browsers/chromium";
const FPS = 30;
const W = 1080;
const H = 1920;

export type StyleRenderReport = {
  style: CodedStyleSpec["style"];
  label: "made in agent mode";
  measured: { durationMs: number; frames: number; meanMotion: number; loopDistance: number; integratedLufs: number | null; truePeakDbfs: number | null };
};

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Mean absolute luma change per frame step, and the first-to-last distance (the engine's loopDistance), from the encoded file. */
function measureMotion(video: string): { meanMotion: number; loopDistance: number; frames: number } {
  const w = 90, h = 160;
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 }).stdout;
  const frames = Math.floor(raw.length / (w * h));
  let total = 0;
  for (let f = 1; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < w * h; i++) sum += Math.abs((raw[f * w * h + i] ?? 0) - (raw[(f - 1) * w * h + i] ?? 0));
    total += sum / (w * h) / 255;
  }
  let d = 0;
  for (let i = 0; i < w * h; i++) d += Math.abs((raw[i] ?? 0) - (raw[(frames - 1) * w * h + i] ?? 0));
  return { meanMotion: Number((total / Math.max(1, frames - 1)).toFixed(4)), loopDistance: Number((d / (w * h) / 255).toFixed(4)), frames };
}

function loudness(file: string): { integratedLufs: number | null; truePeakDbfs: number | null } {
  const err = spawnSync("ffmpeg", ["-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const i = [...err.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop()?.[1];
  const p = [...err.matchAll(/Peak:\s+(-?[0-9.]+) dBFS/g)].pop()?.[1];
  return { integratedLufs: i ? Number(i) : null, truePeakDbfs: p ? Number(p) : null };
}

/** Two-pass loudnorm to -14 LUFS integrated, -1 dBTP, after a gentle compressor and a limiter so the target is met in linear mode. */
function master(input: string, output: string): void {
  const glued = output.replace(/\.wav$/, ".glued.wav");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", "acompressor=threshold=-20dB:ratio=3:attack=4:release=90:makeup=2,alimiter=limit=0.6:level=false", glued]);
  const probe = spawnSync("ffmpeg", ["-i", glued, "-af", "loudnorm=I=-14:TP=-1:LRA=9:print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const json = JSON.parse(probe.slice(probe.lastIndexOf("{"), probe.lastIndexOf("}") + 1)) as Record<string, string>;
  const filter = `loudnorm=I=-14:TP=-1:LRA=9:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`;
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", glued, "-af", filter, "-ar", "48000", "-ac", "2", output]);
}

export function loadSpec(path: string): CodedStyleSpec {
  return codedStyleSpecSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function renderStyle(spec: CodedStyleSpec, out: string, options: { stills?: number[] } = {}): Promise<StyleRenderReport | null> {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: BROWSER });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<html><body style="margin:0;background:#000"><canvas id="c" width="${W}" height="${H}"></canvas></body></html>`);
  await page.addScriptTag({ path: join(STYLES, "common.js") });
  await page.addScriptTag({ path: join(STYLES, STYLE_MODULES[spec.style]) });
  await page.evaluate(() => document.fonts.ready);
  const info = await page.evaluate((s) => {
    const w = window as unknown as { MeridianStyles: Record<string, { cues: (spec: unknown) => StyleCue[]; bed: StyleBed }> };
    const style = w.MeridianStyles[s.style];
    if (!style) throw new Error(`no style module registered for ${s.style}`);
    return { cues: style.cues(s), bed: style.bed };
  }, spec);
  const draw = (t: number, frame: number) =>
    page.evaluate(([s, tt, ff]) => {
      const w = window as unknown as { MeridianStyles: Record<string, { draw: (ctx: CanvasRenderingContext2D, t: number, frame: number, spec: unknown) => void }> };
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      w.MeridianStyles[(s as { style: string }).style]!.draw(ctx, tt as number, ff as number, s);
      return canvas.toDataURL("image/png");
    }, [spec, t, frame] as const);
  const pngOf = (data: string) => Buffer.from(data.split(",")[1] ?? "", "base64");

  if (options.stills) {
    for (const t of options.stills) writeFileSync(join(out, `t${t.toFixed(2)}.png`), pngOf(await draw(t, Math.round(t * FPS))));
    await browser.close();
    if (errors.length > 0) throw new Error(`the style module failed: ${errors.join("; ")}`);
    return null;
  }

  const silent = join(out, "video.silent.mp4");
  const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", silent], { stdio: ["pipe", "ignore", "inherit"] });
  const frames = Math.round((spec.durationMs / 1000) * FPS);
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    const png = pngOf(await draw(f / FPS, f));
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${frames}, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  ff.stdin.end();
  await new Promise<void>((r, j) => ff.on("close", (code) => (code === 0 ? r() : j(new Error(`ffmpeg ${code}`)))));
  await browser.close();
  if (errors.length > 0) throw new Error(`the style module failed: ${errors.join("; ")}`);

  writeWav(join(out, "track.raw.wav"), styleTrack(info.bed, spec.durationMs / 1000, info.cues));
  master(join(out, "track.raw.wav"), join(out, "track.wav"));
  const video = join(out, "video.mp4");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", silent, "-i", join(out, "track.wav"), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", video]);
  const motion = measureMotion(silent);
  const report: StyleRenderReport = {
    style: spec.style,
    label: "made in agent mode",
    measured: { durationMs: Math.round((motion.frames / FPS) * 1000), frames: motion.frames, meanMotion: motion.meanMotion, loopDistance: motion.loopDistance, ...loudness(video) },
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "cues.json"), JSON.stringify(info.cues, null, 1));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const specPath = arg(args, "--spec");
  if (!specPath) throw new Error("pass --spec <spec.json>");
  const out = resolve(arg(args, "--out") ?? "styles-out");
  const stills = arg(args, "--stills")?.split(",").map(Number);
  const report = await renderStyle(loadSpec(specPath), out, { stills });
  if (report) {
    console.log(JSON.stringify(report.measured));
    console.log(`wrote ${join(out, "video.mp4")} (made in agent mode)`);
  } else console.log(`stills written to ${out}`);
}
