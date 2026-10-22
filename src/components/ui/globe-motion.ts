// The meridian globe's motion and projection. The in-app mark (globe.tsx) and the motion prototype (docs/design/logo/meridian-logo.html)
// use these same numbers, so the app and the film show one movement. Section g of docs/design/KATANA_DESIGN_PLAN.md is the spec.
//
// Nothing here eases. The globe turns at one steady speed, the comet runs at one steady speed, and the camera does not move. So the
// motion has no stop, no reversal and no seam: the red meridian comes edge-on to the front at t = 0, opens into a full ring as the
// globe turns, carries on round to the back, and comes back to the front on the next loop.

type Vec = [number, number, number];

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

/** One turn of the globe, which is also the loop. */
export const LOOP_SECONDS = 12;
/** The comet's laps of the meridian per loop: 2.4 s a lap. */
export const COMET_LAPS = 5;
/** The comet's trail along the meridian: the stretch the head covered over the last 1.1 s (section g). At 2.4 s a lap, that is 165 degrees. */
export const TRAIL_DEG = (360 * 1.1) / (LOOP_SECONDS / COMET_LAPS);
/** The meridian's faint full ring, so the circle always reads. */
export const RING_ALPHA = 0.32;
/** The ring and the comet sit just outside the globe. */
export const RING_RADIUS = 1.035;
/** The front view: a perspective camera about 19 degrees above the equator, 5 globe radii away, with a 30 degree field of view. */
export const CAMERA = { distance: 5, height: 1.7, fovDeg: 30 } as const;
/** The drawing area of the mark, in viewBox units. The globe is 44 units across. */
export const VIEW_SIZE = 48;
export const GLOBE_RADIUS = 22;

const CENTRE = VIEW_SIZE / 2;
const UP: Vec = [0, 1, 0];
const LATITUDES = [-45, 0, 45];
/** The grey meridians, by longitude. The red meridian, at 90 degrees, is the ring and the comet, drawn by meridianPoint. */
const GREY_MERIDIANS = [0, 45, 135];
const COMET_SEGMENTS = 24;
const CIRCLE_SAMPLES = 128;
/** The comet, and its head, are dimmed while they are behind the globe. */
const FAR_COMET_DIM = 0.25;

/** Opacity of the grid lines (section f): near side 28 per cent, far side 10 per cent. The rim is 35 per cent. */
export const LINE_ALPHA = { near: 0.28, far: 0.1, rim: 0.35 } as const;

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec): Vec => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

// The camera. It looks at the origin, so the globe's centre projects to the middle of the mark.
const EYE: Vec = [0, CAMERA.height, CAMERA.distance];
const EYE_LENGTH = Math.hypot(...EYE);
const VIEW_Z = norm(EYE);
const VIEW_X = norm(cross(UP, VIEW_Z));
const VIEW_Y = cross(VIEW_Z, VIEW_X);
const FOCAL = 1 / Math.tan((CAMERA.fovDeg * DEG) / 2);
/** The globe's silhouette, as a distance on the image plane: the radius a unit sphere projects to. */
const SILHOUETTE = FOCAL / Math.sqrt(EYE_LENGTH * EYE_LENGTH - 1);
const SCALE = GLOBE_RADIUS / SILHOUETTE;

/** The globe's turn and the comet's angle along the meridian, in radians. Both are linear in t: the motion never changes speed. */
export type Pose = { spin: number; head: number };

/** The loop time in [0, LOOP_SECONDS). */
export function wrapSeconds(t: number): number {
  return ((t % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
}

/** The pose at time t. The comet starts at the bottom of the meridian (pi). It has made exactly COMET_LAPS laps at the loop's end. */
export function poseAt(t: number): Pose {
  const u = wrapSeconds(t) / LOOP_SECONDS;
  return { spin: TAU * u, head: Math.PI + TAU * COMET_LAPS * u };
}

/** The globe's rotation about its polar axis, applied to a point of the globe. */
function spin(p: Vec, angle: number): Vec {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
}

/** A point of the scene in SVG units, and its position relative to the camera's view axis (positive is toward the viewer). */
export function project(p: Vec): { x: number; y: number; toward: number } {
  const d = sub(p, EYE);
  const k = FOCAL / -dot(d, VIEW_Z);
  return {
    x: CENTRE + SCALE * dot(d, VIEW_X) * k,
    y: CENTRE - SCALE * dot(d, VIEW_Y) * k,
    toward: dot(p, VIEW_Z),
  };
}

/** A point of a globe line is on the near side when the camera can see it: the same test the shader makes for a sphere. */
function nearOnGlobe(p: Vec): boolean {
  return dot(p, EYE) > 1;
}

/** A point of the ring or the comet is on the near side unless it is behind the globe. */
function nearOverGlobe(p: Vec): boolean {
  const s = project(p);
  return s.toward > 0 || Math.hypot(s.x - CENTRE, s.y - CENTRE) >= GLOBE_RADIUS;
}

/** The point on the red meridian at angle psi, where psi = 0 is the top and pi the bottom, at the globe's current turn. */
export function meridianPoint(psi: number, spinAngle: number): Vec {
  const e2 = spin([0, 0, 1], spinAngle);
  return scale(add(scale(UP, Math.cos(psi)), scale(e2, Math.sin(psi))), RING_RADIUS);
}

/** Stroke widths in viewBox units for a mark drawn at `size` pixels, from section f: each one scales with the globe, with a minimum in pixels. */
export type StrokeWidths = { hairline: number; rim: number; head: number; tail: number; headDot: number };

export function strokeWidths(size: number): StrokeWidths {
  const globe = 2 * GLOBE_RADIUS;
  const units = (px: number) => (px * VIEW_SIZE) / size;
  return {
    hairline: Math.max(globe / 500, units(1)),
    rim: units(1),
    head: Math.max(globe / 170, units(2)),
    tail: Math.max(globe / 600, units(0.8)),
    headDot: Math.max(globe / 160, units(2)),
  };
}

type Sample = { x: number; y: number; near: boolean };
/** The two halves of a line: the part on the near side and the part behind the globe. Each is an SVG path string, or '' when empty. */
export type LinePaths = { near: string; far: string };

function circleSamples(at: (angle: number) => Vec, near: (p: Vec) => boolean): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < CIRCLE_SAMPLES; i++) {
    const p = at((TAU * i) / CIRCLE_SAMPLES);
    const s = project(p);
    out.push({ x: s.x, y: s.y, near: near(p) });
  }
  return out;
}

/**
 * Splits a closed loop of samples into its near and far runs. The loop starts where the visibility changes and is closed back to that
 * point, so every segment is drawn once. A run hands over at a change: the next run starts at the last point of the one before, so no
 * segment is left out where the line passes behind the globe.
 */
function closedPaths(samples: Sample[]): LinePaths {
  const n = samples.length;
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (samples[i].near !== samples[(i - 1 + n) % n].near) {
      start = i;
      break;
    }
  }
  const seq = [...samples.slice(start), ...samples.slice(0, start), samples[start]];
  const near: string[] = [];
  const far: string[] = [];
  let run: { near: boolean; text: string[] } | null = null;
  const flush = () => {
    if (run && run.text.length > 1) (run.near ? near : far).push(`M${run.text.join(" L")}`);
    run = null;
  };
  for (const s of seq) {
    const coord = `${s.x.toFixed(2)} ${s.y.toFixed(2)}`;
    if (!run) {
      run = { near: s.near, text: [coord] };
    } else if (run.near !== s.near) {
      const last: string = run.text[run.text.length - 1];
      flush();
      run = { near: s.near, text: [last, coord] };
    } else {
      run.text.push(coord);
    }
  }
  flush();
  return { near: near.join(" "), far: far.join(" ") };
}

export type CometSegment = { d: string; width: number; opacity: number };

/** One frame of the mark, in SVG units, at time t. Pure: the same t always gives the same frame. */
export type MarkFrame = {
  latitudes: LinePaths[];
  meridians: LinePaths[];
  ring: LinePaths;
  comet: CometSegment[];
  head: { x: number; y: number; r: number; opacity: number };
  widths: StrokeWidths;
};

export function markFrame(t: number, size: number): MarkFrame {
  const pose = poseAt(t);
  const widths = strokeWidths(size);
  const latitudes = LATITUDES.map((lat) => {
    const phi = lat * DEG;
    return closedPaths(circleSamples((a) => spin([Math.cos(a) * Math.cos(phi), Math.sin(phi), Math.sin(a) * Math.cos(phi)], pose.spin), nearOnGlobe));
  });
  const meridians = GREY_MERIDIANS.map((lon) => {
    const lambda = lon * DEG;
    const side: Vec = [Math.cos(lambda), 0, Math.sin(lambda)];
    return closedPaths(circleSamples((a) => spin(add(scale(UP, Math.cos(a)), scale(side, Math.sin(a))), pose.spin), nearOnGlobe));
  });
  const ring = closedPaths(circleSamples((a) => meridianPoint(a, pose.spin), nearOverGlobe));

  // The comet: the stretch of the meridian the head covered in the last TRAIL_DEG, in equal segments, so it fades from tail to head.
  const trail = (TRAIL_DEG * DEG) / COMET_SEGMENTS;
  const comet: CometSegment[] = [];
  for (let i = 0; i < COMET_SEGMENTS; i++) {
    const from = meridianPoint(pose.head - (COMET_SEGMENTS - i) * trail, pose.spin);
    const to = meridianPoint(pose.head - (COMET_SEGMENTS - i - 1) * trail, pose.spin);
    const k = (i + 0.5) / COMET_SEGMENTS;
    const a = project(from);
    const b = project(to);
    const behind = !nearOverGlobe(scale(add(from, to), 0.5));
    comet.push({
      d: `M${a.x.toFixed(2)} ${a.y.toFixed(2)} L${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
      width: widths.tail + (widths.head - widths.tail) * Math.pow(k, 1.4),
      opacity: (RING_ALPHA + (1 - RING_ALPHA) * Math.pow(k, 1.8)) * (behind ? FAR_COMET_DIM : 1),
    });
  }
  const head = meridianPoint(pose.head, pose.spin);
  const headPoint = project(head);
  const headOpacity = nearOverGlobe(head) ? 1 : FAR_COMET_DIM;
  return { latitudes, meridians, ring, comet, head: { x: headPoint.x, y: headPoint.y, r: widths.headDot, opacity: headOpacity }, widths };
}
