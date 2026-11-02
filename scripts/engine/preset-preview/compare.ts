// Measures two videos with Meridian's own media handlers (functions/ffmpeg) and analysis code (analyze/measures.ts, which uses zoom.ts and beats.ts),
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
import { measuresOf, type Measures } from "../../../src/engine/analyze/measures.ts";
import { mediaConfig } from "../../../src/engine/media/config.ts";

async function measure(path: string): Promise<Measures> {
  const source = { kind: "bytes" as const, bytes: new Uint8Array(await readFile(path)) };
  const probed = await probe.run({ source });
  const cut = (await cuts.run({ source, sceneScore: mediaConfig.sceneCutScore.value })).cutsMs;
  const loud = await loudness.run({ source });
  const pic = await picture.run({ source, cutsMs: cut });
  const motion = await detectors.motionRun({ source });
  const flicker = await detectors.flickerRun({ source });
  const tl = await timeline.run({ source });
  // The derivation is in src/engine/analyze/measures.ts (K22), so the report and its tests share one set of measures.
  return measuresOf({
    durationMs: probed.durationMs ?? null,
    cutsMs: cut,
    pairs: pic.pairs,
    loopDistance: pic.loopDistance,
    meanMotion: motion.meanMotion,
    flickerScore: flicker.flickerScore,
    brightness: tl.brightness.map((sample: { value: number }) => sample.value),
    integratedLufs: loud.integratedLufs,
    loudnessRangeLu: loud.loudnessRangeLu,
  });
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
