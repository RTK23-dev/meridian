// The directed-versus-described benchmark for the code-drawn crew (L12). The same idea twice: once as directed (the film and its
// build), once as described (the same cards and the same worlds, but what a one-line prompt gives: nothing happens on the beat, the
// words sit over the subject, the camera drifts, the film stops instead of looping, no sound on the moments). Both are drawn by the
// same engine and scored by the same checks, and a side-by-side video is written, directed on top.
//
//   node --experimental-strip-types scripts/engine/pixel-explainer/bench.ts --out dir [--film f.json --build b.json]

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PixelBuild } from "../../../src/engine/compose/pixel/stage.ts";
import type { DirectedFilm } from "../../../src/engine/direction/film.ts";
import { loadBuild, loadFilm, render, type RenderReport } from "./render.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The described control of a directed film: the same words and worlds, with the direction taken out. */
export function describe(film: DirectedFilm, build: PixelBuild): { film: DirectedFilm; build: PixelBuild } {
  const described: DirectedFilm = {
    ...film,
    filmId: `${film.filmId}-described`,
    loop: "none",
    shots: film.shots.map((shot) => ({
      ...shot,
      loop: "none",
      sound: { hitSfx: "none" },
      motionStyle: { cadence: "ones", smears: false, squashStretch: false },
      composition: { ...shot.composition, camera: "pan", emptyBand: "centre" },
    })),
    cards: film.cards.map((card) => ({ ...card, band: "centre" as const })),
  };
  const stages = build.stages.map((stage) => ({
    ...stage,
    // A slow, aimless drift instead of the directed camera.
    camera: { move: "pan" as const, from: { ...stage.camera.to, x: stage.camera.to.x - 6 }, to: { ...stage.camera.to, x: stage.camera.to.x + 6 }, curve: "linear" as const },
    // Every actor only idles: no moment, no arc, no reaction; a field moves in step.
    actors: stage.actors.map((actor) => ({
      ...actor,
      hidden: false,
      repeat: actor.repeat ? { ...actor.repeat, stagger: 0, spin: 0 } : undefined,
      actions: [{ do: "bob" as const, atMs: 0, durMs: 60000, amount: 1.5, hz: 0.8 }],
    })),
    fx: [],
  }));
  return { film: described, build: { ...build, filmId: described.filmId, stages } };
}

function score(report: RenderReport, film: DirectedFilm) {
  const count = (list: Array<{ severity: string; rule: string }>, rule: string) => list.filter((f) => f.rule === rule).length;
  return {
    momentsVisible: film.shots.length - count(report.take, "moment_invisible"),
    shots: film.shots.length,
    momentsBuilt: film.shots.length - count(report.faith, "moment_not_built"),
    wordsOverSubject: count(report.direction, "card_over_subject") + count(report.faith, "subject_in_word_band"),
    silentMoments: count(report.direction, "moment_silent"),
    loopDistance: report.measured.firstLastDistance,
    loops: report.measured.firstLastDistance <= 0.04,
    meanMotion: report.measured.meanMotion,
    blocks: [...report.direction, ...report.faith, ...report.take].filter((f) => f.severity === "block").length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const out = resolve(arg("--out") ?? "pixel-bench");
  const film = loadFilm(arg("--film") ?? resolve(here, "../../../src/engine/direction/fixtures/microwave.film.json"));
  const build = loadBuild(arg("--build") ?? resolve(here, "../../../src/engine/direction/fixtures/microwave.build.json"));
  const control = describe(film, build);
  const directed = await render(film, build, join(out, "directed"));
  const described = await render(control.film, control.build, join(out, "described"), { force: true });
  if (directed === null || described === null) throw new Error("no report");
  const table = { directed: score(directed, film), described: score(described, control.film), label: "made in agent mode" };
  writeFileSync(join(out, "bench.json"), JSON.stringify(table, null, 2));
  spawnSync("ffmpeg", [
    "-y", "-v", "error", "-i", join(out, "directed", "video.mp4"), "-i", join(out, "described", "video.silent.mp4"),
    "-filter_complex", "[0:v]scale=360:640[a];[1:v]scale=360:640[b];[a][b]hstack=inputs=2[v]", "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-crf", "18", "-c:a", "copy",
    join(out, "directed-vs-described.mp4"),
  ]);
  console.log(JSON.stringify(table, null, 2));
}
