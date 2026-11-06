// Designer motion for compositions (motion-kit by Hugh Phan, MIT, vendored as motion-kit.js beside this file; see README.md).
//
// The compiler writes motion-kit.js into every composition at MOTION_KIT_PATH and loads it after GSAP, so the root timeline and every
// component author with the same curves: a curve chosen per move, duration from distance and weight, a lead and uneven reactions, springs
// for physical landings. This module holds the same curves as data, for code that does not run GSAP (canvas renderers, the motion lint,
// agent-mode scenes); kit.test.ts checks that the numbers match motion-kit.js exactly.

import { sourceFile } from "../../source-file.ts";

/** Where the kit lives in a compiled composition. Components load it as `../lib/motion-kit.js`. */
export const MOTION_KIT_PATH = "lib/motion-kit.js";

/** The vendored kit, byte for byte. Read on first use, never at module load (see source-file.ts). */
export const motionKitSource = sourceFile(import.meta.url, "./motion-kit.js", "src/engine/compose/motion/motion-kit.js");

/** The upstream commit the vendored file is taken from. */
export const MOTION_KIT_UPSTREAM = { repo: "https://github.com/hughminhphan/motion-kit", commit: "6173e5c408f81f1989435843af3f0788b74bda96" } as const;

export type Bezier = readonly [x1: number, y1: number, x2: number, y2: number];

/** Every curve the kit names, as cubic-bezier control points (the same numbers as CSS, an After Effects speed graph or Blender). */
export const KIT_CURVES = {
  "kit.land": [0.1, 0.75, 0.15, 1],
  "kit.heavy": [0.75, 0, 0.18, 1],
  "kit.whip": [0.85, 0, 0.15, 1],
  "kit.reveal": [0.22, 1, 0.36, 1],
  "kit.leave": [0.55, 0, 0.9, 0.35],
  "kit.wind": [0.45, 0, 0.55, 1],
  "kit.drift": [0.4, 0, 0.6, 1],
  "easings.inSine": [0.12, 0, 0.39, 0],
  "easings.outSine": [0.61, 1, 0.88, 1],
  "easings.inOutSine": [0.37, 0, 0.63, 1],
  "easings.inQuad": [0.11, 0, 0.5, 0],
  "easings.outQuad": [0.5, 1, 0.89, 1],
  "easings.inOutQuad": [0.45, 0, 0.55, 1],
  "easings.inCubic": [0.32, 0, 0.67, 0],
  "easings.outCubic": [0.33, 1, 0.68, 1],
  "easings.inOutCubic": [0.65, 0, 0.35, 1],
  "easings.inQuart": [0.5, 0, 0.75, 0],
  "easings.outQuart": [0.25, 1, 0.5, 1],
  "easings.inOutQuart": [0.76, 0, 0.24, 1],
  "easings.inQuint": [0.64, 0, 0.78, 0],
  "easings.outQuint": [0.22, 1, 0.36, 1],
  "easings.inOutQuint": [0.83, 0, 0.17, 1],
  "easings.inExpo": [0.7, 0, 0.84, 0],
  "easings.outExpo": [0.16, 1, 0.3, 1],
  "easings.inOutExpo": [0.87, 0, 0.13, 1],
  "easings.inCirc": [0.55, 0, 1, 0.45],
  "easings.outCirc": [0, 0.55, 0.45, 1],
  "easings.inOutCirc": [0.85, 0, 0.15, 1],
  "easings.inBack": [0.36, 0, 0.66, -0.56],
  "easings.outBack": [0.34, 1.56, 0.64, 1],
  "easings.inOutBack": [0.68, -0.6, 0.32, 1.6],
  "m3.standard": [0.2, 0, 0, 1],
  "m3.standardDecelerate": [0, 0, 0, 1],
  "m3.standardAccelerate": [0.3, 0, 1, 1],
  "m3.emphasizedDecelerate": [0.05, 0.7, 0.1, 1],
  "m3.emphasizedAccelerate": [0.3, 0, 0.8, 0.15],
  "m3.legacy": [0.4, 0, 0.2, 1],
  "m3.legacyDecelerate": [0, 0, 0.2, 1],
  "m3.legacyAccelerate": [0.4, 0, 1, 1],
  "carbon.productive.standard": [0.2, 0, 0.38, 0.9],
  "carbon.productive.entrance": [0, 0, 0.38, 0.9],
  "carbon.productive.exit": [0.2, 0, 1, 0.9],
  "carbon.expressive.standard": [0.4, 0.14, 0.3, 1],
  "carbon.expressive.entrance": [0, 0, 0.3, 1],
  "carbon.expressive.exit": [0.4, 0.14, 1, 1],
  "ramp.slowMid": [0.1, 0.6, 0.9, 0.4],
  "ramp.speedUp": [0.6, 0, 0.9, 0.55],
  "ramp.slowDown": [0.1, 0.45, 0.4, 1],
} as const satisfies Record<string, Bezier>;

export type CurveName = keyof typeof KIT_CURVES;

/** A cubic-bezier ease, solved the same way motion-kit.js solves it: progress 0..1 in, eased value out. */
export function bez(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-6) return t;
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : sy(solve(p)));
}

/** A named curve as an ease function. */
export function curve(name: CurveName): (p: number) => number {
  const [x1, y1, x2, y2] = KIT_CURVES[name];
  return bez(x1, y1, x2, y2);
}

const FPS = 60;

/** Duration from distance and weight, in seconds: (9 + 1.15·√px)·weight frames at 60 fps. Weight 0.7 light, 1 normal, 1.35 heavy. */
export function dur(distancePx: number, weight = 1): number {
  return Math.round((9 + 1.15 * Math.sqrt(Math.max(0, distancePx))) * weight) / FPS;
}

const REACT = [0, 4, 9, 15, 22, 30];

/** The i-th follower's uneven offset after the lead, in seconds (0, 4, 9, 15, 22, 30 frames, then 8 more each). */
export function react(i: number, scale = 1): number {
  const frames = REACT[i] ?? REACT[REACT.length - 1]! + 8 * (i - REACT.length + 1);
  return Math.round(frames * scale) / FPS;
}
