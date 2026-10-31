// Measures two videos with Meridian's own media handlers (functions/ffmpeg) and analysis code (analyze/zoom.ts, analyze/beats.ts),
// and prints them side by side: the reference a preset was built from, and a render made with the preset. No network, no spend.
//
//   node --experimental-strip-types scripts/engine/preset-preview/compare.ts <reference.mp4> <render.mp4> [out.json]

import { readFile, writeFile } from "node:fs/promises";
import * as cuts from "../../../functions/ffmpeg/cuts.ts";
import * as detectors from "../../../functions/ffmpeg/detectors.ts";
import * as loudness from "../../../functions/ffmpeg/loudness.ts";
import * as picture from "../../../functions/ffmpeg/picture.ts";
import * as probe from "../../../functions/ffmpeg/probe.ts";
import * as timeline from "../../../functions/ffmpeg/timeline.ts";
import { median, percentile } from "../../../src/engine/analyze/beats.ts";
import { loopOf, zoomJumps } from "../../../src/engine/analyze/zoom.ts";
import { mediaConfig } from "../../../src/engine/media/config.ts";

type Measures = Record<string, number | string | null>;

async function measure(path: string): Promise<Measures> {
  const source = { kind: "bytes" as const, bytes: new Uint8Array(await readFile(path)) };
  const probed = await probe.run({ source });
  const d = probed.durationMs ?? 0;
  const cut = (await cuts.run({ source, sceneScore: mediaConfig.sceneCutScore.value })).cutsMs;
  const loud = await loudness.run({ source });
  const pic = await picture.run({ source, cutsMs: cut });
  const motion = await detectors.motionRun({ source });
  const flicker = await detectors.flickerRun({ source });
  const tl = await timeline.run({ source });
  const jumps = zoomJumps(pic.pairs) ?? [];
  const bounds = [0, ...cut, d];
  const shots = bounds.slice(1).map((end, i) => end - (bounds[i] ?? 0));
  const ins = jumps.filter((jump) => jump.scale > 1);
  const interrupts = [...new Set([...cut, ...jumps.map((jump) => jump.atMs)])].sort((a, b) => a - b);
  const ib = [0, ...interrupts, d];
  const gaps = ib.slice(1).map((end, i) => end - (ib[i] ?? 0)).filter((gap) => gap > 0);
  const brightness = tl.brightness.map((sample: { value: number }) => sample.value);
  return {
    durationMs: d,
    hardCuts: cut.length,
    firstCutMs: cut[0] ?? null,
    shotP25Ms: Math.round(percentile(shots, 25)),
    shotP50Ms: Math.round(percentile(shots, 50)),
    shotP75Ms: Math.round(percentile(shots, 75)),
    zoomJumps: jumps.length,
    punchInsPer10s: Number((ins.length / (d / 10_000)).toFixed(2)),
    punchInScale: ins.length > 0 ? Number(median(ins.map((jump) => jump.scale)).toFixed(2)) : null,
    interruptMedianMs: Math.round(median(gaps)),
    meanMotion: motion.meanMotion === null ? null : Number(motion.meanMotion.toFixed(3)),
    flickerScore: flicker.flickerScore === null ? null : Number(flicker.flickerScore.toFixed(3)),
    meanBrightness: brightness.length > 0 ? Number((brightness.reduce((a: number, b: number) => a + b, 0) / brightness.length).toFixed(3)) : null,
    integratedLufs: loud.integratedLufs,
    loudnessRangeLu: loud.loudnessRangeLu,
    loopDistance: Number(pic.loopDistance?.toFixed(3) ?? "NaN"),
    endsOnLoop: String(loopOf(pic.loopDistance)),
    cutsMs: cut.join(" "),
  };
}

const [referencePath, renderPath, outPath] = process.argv.slice(2);
if (!referencePath || !renderPath) {
  console.error("usage: compare.ts <reference.mp4> <render.mp4> [out.json]");
  process.exit(2);
}
const reference = await measure(referencePath);
const render = await measure(renderPath);
const rows = Object.keys(reference).map((key) => `| ${key} | ${reference[key]} | ${render[key]} |`);
console.log(["| Measure | Reference | Render |", "| --- | --- | --- |", ...rows].join("\n"));
if (outPath) await writeFile(outPath, JSON.stringify({ reference, render }, null, 1));
