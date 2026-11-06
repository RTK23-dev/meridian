// Is the crew's build faithful to the direction (L2)? The crew executes the Director's film and may not change it: every shot has its
// stage, the one moment is built at hitAt, the subject is on the eye target and out of the words' band, and a seamless film ends where it
// began. The check reads the stage's numbers (positions and action times); the take check (take-check.ts) then measures the rendered
// frames. Positions are evaluated with straight-line motion between keys, which is close enough to place a subject, not to time a curve.

import { curve, type CurveName } from "../compose/motion/kit.ts";
import type { PixelBuild, Stage, StageActor } from "../compose/pixel/stage.ts";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "../compose/pixel/stage.ts";
import { BAND_SPANS } from "./check.ts";
import type { DirectedFilm, ShotDirection } from "./film.ts";

export type FaithRule = "stage_missing" | "moment_not_built" | "subject_missing" | "subject_in_word_band" | "subject_off_target" | "loop_seam_open" | "action_past_end";
export type FaithFinding = { rule: FaithRule; severity: "block" | "warn"; at: string; message: string };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Where an actor is at a time in its shot: centre, size and visibility, with straight-line motion between keys. */
export function actorAt(actor: StageActor, tMs: number): { x: number; y: number; w: number; h: number; scale: number; visible: boolean } {
  const state = { x: actor.x, y: actor.y, w: actor.w, h: actor.h, scale: 1, visible: actor.hidden !== true };
  for (const action of [...actor.actions].sort((a, b) => a.atMs - b.atMs)) {
    if (tMs < action.atMs) continue;
    const p = clamp01((tMs - action.atMs) / action.durMs);
    if (action.do === "enter" || action.do === "pop") state.visible = true;
    if (action.do === "exit" && p >= 1) state.visible = false;
    const to = action.to;
    if (to === undefined) continue;
    if (to.x !== undefined) state.x += (to.x - state.x) * p;
    if (to.y !== undefined) state.y += (to.y - state.y) * p;
    if (to.w !== undefined) state.w += (to.w - state.w) * p;
    if (to.h !== undefined) state.h += (to.h - state.h) * p;
    if (to.scale !== undefined) state.scale += (to.scale - state.scale) * p;
  }
  return state;
}

/** The camera's view at a time in its shot, on the same curve the pixel engine uses (a dive zooms on a log scale). */
export function cameraAt(stage: Stage, tMs: number, shotMs: number): { x: number; y: number; zoom: number } {
  const camera = stage.camera;
  const start = camera.atMs ?? 0;
  const length = camera.durMs ?? shotMs - start;
  const dive = camera.move === "dive_in" || camera.move === "dive_out";
  const name = camera.curve ?? (camera.move === "dive_in" ? "kit.heavy" : "kit.drift");
  const raw = clamp01((tMs - start) / Math.max(1, length));
  const p = name === "linear" ? raw : curve(name as CurveName)(raw);
  return {
    x: camera.from.x + (camera.to.x - camera.from.x) * p,
    y: camera.from.y + (camera.to.y - camera.from.y) * p,
    zoom: dive
      ? Math.exp(Math.log(camera.from.zoom) + (Math.log(camera.to.zoom) - Math.log(camera.from.zoom)) * p)
      : camera.from.zoom + (camera.to.zoom - camera.from.zoom) * p,
  };
}

/** The times in a stage at which something visibly changes: instant actions at their start, moves at their arrival, effects. */
export function hitTimes(stage: Stage): number[] {
  const instant = new Set(["pop", "enter", "express", "colour", "squash", "shake", "blink", "jitter", "glow"]);
  const times: number[] = [];
  for (const actor of stage.actors) {
    for (const action of actor.actions) {
      times.push(instant.has(action.do) ? action.atMs : action.atMs + action.durMs);
      if (action.do === "squash" || action.do === "pop") times.push(action.atMs + Math.round(action.durMs / 2));
    }
  }
  for (const fx of stage.fx) times.push(fx.atMs);
  if (stage.camera.atMs !== undefined) times.push(stage.camera.atMs + (stage.camera.durMs ?? 0));
  return times;
}

export function faithFindings(film: DirectedFilm, build: PixelBuild): FaithFinding[] {
  const out: FaithFinding[] = [];
  const add = (rule: FaithRule, severity: "block" | "warn", at: string, message: string) => out.push({ rule, severity, at, message });
  const tolerance = Math.max(70, (2 * 1000) / film.fps);
  const stages = new Map(build.stages.map((stage) => [stage.shotId, stage]));
  const order = build.stages.map((stage) => stage.shotId).join(",");
  if (order !== film.shots.map((shot) => shot.shotId).join(",")) {
    add("stage_missing", "block", "film", "the build must have one stage per shot, in the shots' order");
  }
  for (const shot of film.shots) {
    const stage = stages.get(shot.shotId);
    if (stage === undefined) continue;
    checkShot(film, shot, stage, tolerance, add);
  }
  if (film.loop === "seamless") {
    const first = build.stages[0];
    const last = build.stages[build.stages.length - 1];
    if (first !== undefined && last !== undefined) {
      const a = first.camera.from;
      const b = last.camera.to;
      const same = Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.zoom - b.zoom) <= 0.01;
      if (!same || first.backdrop.kind !== last.backdrop.kind) {
        add("loop_seam_open", "block", last.shotId, "a seamless film's last stage must end on the first stage's opening view and backdrop");
      }
    }
  }
  return out;
}

function checkShot(
  film: DirectedFilm,
  shot: ShotDirection,
  stage: Stage,
  tolerance: number,
  add: (rule: FaithRule, severity: "block" | "warn", at: string, message: string) => void,
): void {
  const length = shot.endMs - shot.startMs;
  const hit = shot.oneMoment.hitAtMs;
  const hudAtHit = film.hud.some((hud) => Math.abs(hud.fromMs - (shot.startMs + hit)) <= tolerance || Math.abs(hud.untilMs - (shot.startMs + hit)) <= tolerance);
  const built = hitTimes(stage).some((time) => Math.abs(time - hit) <= tolerance);
  if (!built && !(shot.oneMoment.kind === "count" && hudAtHit)) {
    add("moment_not_built", "block", shot.shotId, `nothing on the stage changes within ${Math.round(tolerance)} ms of the moment at ${hit} ms`);
  }
  for (const actor of stage.actors) {
    for (const action of actor.actions) {
      if (action.atMs + action.durMs > length + 1) add("action_past_end", "warn", shot.shotId, `${actor.id}'s ${action.do} runs past the shot's end`);
    }
  }
  const subject = stage.actors.find((actor) => actor.id === stage.subjectId);
  if (subject === undefined) {
    add("subject_missing", "block", shot.shotId, `the subject "${stage.subjectId}" is not an actor of the stage`);
    return;
  }
  const at = actorAt(subject, hit);
  // A field of copies is placed by its middle, and is as tall as the whole field.
  if (subject.repeat !== undefined) {
    at.x += ((subject.repeat.cols - 1) * subject.repeat.dx) / 2;
    at.y += ((subject.repeat.rows - 1) * subject.repeat.dy) / 2;
    at.h += Math.abs((subject.repeat.rows - 1) * subject.repeat.dy);
  }
  const view = cameraAt(stage, hit, length);
  const sx = (at.x - view.x) * view.zoom / LOGICAL_WIDTH + 0.5;
  const sy = (at.y - view.y) * view.zoom / LOGICAL_HEIGHT + 0.5;
  const half = (at.h * at.scale * view.zoom) / LOGICAL_HEIGHT / 2;
  const [bandTop, bandBottom] = BAND_SPANS[shot.composition.emptyBand];
  if (sy >= bandTop && sy <= bandBottom) {
    add("subject_in_word_band", "block", shot.shotId, `at the moment the subject's centre (y ${sy.toFixed(2)}) is in the ${shot.composition.emptyBand} band kept for the words`);
  } else if (shot.composition.emptyBand !== "centre" && sy - half < bandBottom && sy + half > bandTop && Math.min(sy + half, bandBottom) - Math.max(sy - half, bandTop) > 0.04) {
    add("subject_in_word_band", "warn", shot.shotId, "at the moment the subject reaches into the band kept for the words");
  }
  const target = shot.composition.eyeTarget;
  const distance = Math.hypot(sx - target.x, sy - target.y);
  if (distance > 0.15) {
    add("subject_off_target", "warn", shot.shotId, `at the moment the subject is ${distance.toFixed(2)} of the frame from the eye target`);
  }
}

export function faithPasses(film: DirectedFilm, build: PixelBuild): boolean {
  return faithFindings(film, build).every((finding) => finding.severity !== "block");
}
