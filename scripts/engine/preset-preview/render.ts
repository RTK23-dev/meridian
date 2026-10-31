// Renders the preset preview (scene.html + show.js) frame by frame in the local Chromium, with the style preset injected, and encodes
// it with ffmpeg. No network, no provider, no spend: the 3D scenes are WebGL shaders and the sound is synthesised by ffmpeg.
//
//   node --experimental-strip-types scripts/engine/preset-preview/render.ts --out artifacts/preset-preview/preview.mp4
//   node --experimental-strip-types scripts/engine/preset-preview/render.ts --stills 1,8,18 --out artifacts/preset-preview
//   Add --chromium /path/to/chrome when Playwright's own browser is not installed.
//
// The output goes to artifacts/ (ignored by git).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { threeDDataExplainer } from "../../../src/engine/presets/three-d-data-explainer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const out = resolve(arg("--out") ?? "artifacts/preset-preview/preview.mp4");
const fps = threeDDataExplainer.reference.fps;
const durationS = threeDDataExplainer.reference.durationMs / 1000;
const stills = arg("--stills")?.split(",").map(Number);

function run(command: string, argv: string[], input?: (stdin: NodeJS.WritableStream) => Promise<void>): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, argv, { stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}: ${err.slice(-800)}`))));
    if (input && child.stdin) input(child.stdin).then(() => child.stdin!.end(), fail);
  });
}

/** The sound bed: a slow minor pad, a soft pulse, whooshes on the cuts and ticks when a ring appears. Loudness to the preset's measure. */
async function soundBed(path: string): Promise<void> {
  const m = threeDDataExplainer.grammar.measured as { cutsMs: number[]; integratedLufs: number; silencesMs: { startMs: number; endMs: number }[] };
  const d = durationS.toFixed(3);
  const whooshes = m.cutsMs.map((ms, i) => `[w${i}]`).join("");
  const parts = [
    `sine=f=110:d=${d},volume=0.5[a1]`,
    `sine=f=164.81:d=${d},volume=0.35[a2]`,
    `sine=f=261.63:d=${d},volume=0.18,tremolo=f=0.25:d=0.6[a3]`,
    `sine=f=55:d=${d},volume=0.6,tremolo=f=1.6:d=0.9[a4]`,
    ...m.cutsMs.map((ms, i) => `anoisesrc=d=0.5:c=pink:a=0.5,highpass=f=600,lowpass=f=5000,afade=t=in:d=0.3,afade=t=out:st=0.3:d=0.2,adelay=${Math.max(0, ms - 300)}:all=1,apad=whole_dur=${d}[w${i}]`),
  ];
  const mutes = m.silencesMs.map((s) => `volume=enable='between(t,${s.startMs / 1000},${s.endMs / 1000})':volume=0`).join(",");
  const graph = `${parts.join(";")};[a1][a2][a3][a4]${whooshes}amix=inputs=${4 + m.cutsMs.length}:normalize=0,lowpass=f=6000,${mutes},loudnorm=I=${m.integratedLufs}:TP=-1.5:LRA=7[out]`;
  await run("ffmpeg", ["-y", "-v", "error", "-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-ac", "2", "-t", d, path]);
}

// The repository pins its own Playwright; --chromium points at another Chromium when that one is not installed.
const executablePath = arg("--chromium");
const browser = await chromium.launch({ executablePath, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.addInitScript(`window.PRESET = ${JSON.stringify(threeDDataExplainer)};`);
  await page.goto(pathToFileURL(join(here, "scene.html")).href);
  await page.evaluate("window.__ready");
  const stage = page.locator("#stage");

  if (stills) {
    mkdirSync(out, { recursive: true });
    for (const t of stills) {
      const started = Date.now();
      await page.evaluate(`renderAt(${t})`);
      writeFileSync(join(out, `still_${t}.png`), await stage.screenshot({ type: "png" }));
      console.log(`still ${t}s in ${Date.now() - started} ms`);
    }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    const silent = out.replace(/\.mp4$/, ".video.mp4");
    const audio = out.replace(/\.mp4$/, ".audio.wav");
    const frames = Math.round(durationS * fps);
    const started = Date.now();
    await run(
      "ffmpeg",
      ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", silent],
      async (stdin) => {
        for (let frame = 0; frame < frames; frame++) {
          await page.evaluate(`renderAt(${frame / fps})`);
          const jpeg = await stage.screenshot({ type: "jpeg", quality: 92 });
          if (!stdin.write(jpeg)) await new Promise((ok) => stdin.once("drain", ok));
          if (frame % 150 === 0) console.log(`frame ${frame}/${frames}, ${Math.round((Date.now() - started) / 1000)} s`);
        }
      },
    );
    await soundBed(audio);
    await run("ffmpeg", ["-y", "-v", "error", "-i", silent, "-i", audio, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]);
    console.log(`wrote ${out} in ${Math.round((Date.now() - started) / 1000)} s`);
  }
} finally {
  await browser.close();
}
