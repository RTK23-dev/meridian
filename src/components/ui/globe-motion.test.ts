import assert from "node:assert/strict";
import test from "node:test";
import {
  COMET_LAPS,
  GLOBE_RADIUS,
  LOOP_SECONDS,
  RING_RADIUS,
  TRAIL_DEG,
  VIEW_SIZE,
  markFrame,
  meridianPoint,
  poseAt,
  project,
  strokeWidths,
  wrapSeconds,
} from "./globe-motion.ts";

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
/** Each closed line of the mark is drawn from this many samples. */
const SAMPLES = 128;

/** A forward step of an angle, in [0, TAU): a turn past the loop's end is the same step as any other. */
const forward = (angle: number) => ((angle % TAU) + TAU) % TAU;

/** The segments a path string draws: each "L" adds one, and each "M" starts a run of its own. */
function segments(d: string): number {
  return d.split("M").filter(Boolean).reduce((sum, run) => sum + run.split("L").length - 1, 0);
}

/** The numbers in a comet segment's path, as [x1, y1, x2, y2]. */
function coords(d: string): number[] {
  return d.match(/-?[\d.]+/g)!.map(Number);
}

/** The horizontal extent, in SVG units, of the red meridian's full circle at time t. */
function ringWidth(t: number): number {
  const { spin } = poseAt(t);
  const xs = Array.from({ length: 256 }, (_, i) => project(meridianPoint((TAU * i) / 256, spin)).x);
  return Math.max(...xs) - Math.min(...xs);
}

test("time wraps into one loop", () => {
  assert.equal(wrapSeconds(-1), LOOP_SECONDS - 1);
  assert.equal(wrapSeconds(LOOP_SECONDS + 1), 1);
  assert.equal(wrapSeconds(LOOP_SECONDS), 0);
});

test("the globe and the comet step at one steady rate, with no easing", () => {
  const dt = 0.1;
  for (let k = 0; k < 240; k++) {
    const a = poseAt(k * dt);
    const b = poseAt((k + 1) * dt);
    assert.ok(Math.abs(forward(b.spin - a.spin) - (TAU / LOOP_SECONDS) * dt) < 1e-9, `globe step at ${k}`);
    assert.ok(Math.abs(forward(b.head - a.head) - ((TAU * COMET_LAPS) / LOOP_SECONDS) * dt) < 1e-9, `comet step at ${k}`);
  }
});

test("one loop is COMET_LAPS laps, so a lap is 2.4 s", () => {
  assert.equal(LOOP_SECONDS / COMET_LAPS, 2.4);
  const laps = (poseAt(LOOP_SECONDS - 1e-6).head - poseAt(0).head) / TAU;
  assert.ok(Math.abs(laps - COMET_LAPS) < 1e-5);
});

test("the loop closes on the frame it opened with", () => {
  assert.deepEqual(markFrame(LOOP_SECONDS, VIEW_SIZE), markFrame(0, VIEW_SIZE));
  assert.deepEqual(markFrame(-LOOP_SECONDS, VIEW_SIZE), markFrame(0, VIEW_SIZE));
  const before = markFrame(LOOP_SECONDS - 1e-6, VIEW_SIZE).head;
  const after = markFrame(0, VIEW_SIZE).head;
  assert.ok(Math.abs(before.x - after.x) < 1e-3 && Math.abs(before.y - after.y) < 1e-3);
});

test("the red meridian is edge-on at t = 0 and a full circle a quarter loop later", () => {
  assert.ok(ringWidth(0) < 1e-9);
  assert.ok(ringWidth(LOOP_SECONDS / 4) > 0.95 * 2 * RING_RADIUS * GLOBE_RADIUS);
});

test("the trail is the 1.1 s the head covered, 165 degrees, and never changes length", () => {
  assert.ok(Math.abs(TRAIL_DEG - 165) < 1e-9);
  for (const t of [0, 1.3, 4.7, 9.9]) {
    const { spin, head } = poseAt(t);
    const tail = meridianPoint(head - TRAIL_DEG * DEG, spin);
    const front = meridianPoint(head, spin);
    const cos = (tail[0] * front[0] + tail[1] * front[1] + tail[2] * front[2]) / (RING_RADIUS * RING_RADIUS);
    assert.ok(Math.abs(Math.acos(cos) / DEG - TRAIL_DEG) < 1e-6, `trail at ${t}`);
  }
});

test("the comet is one unbroken line from its trail's tail to its head, on the meridian", () => {
  for (const t of [0, 2.2, 6.1]) {
    const frame = markFrame(t, VIEW_SIZE);
    const { spin, head } = poseAt(t);
    const tail = project(meridianPoint(head - TRAIL_DEG * DEG, spin));
    const front = project(meridianPoint(head, spin));
    const first = coords(frame.comet[0].d);
    const last = coords(frame.comet[frame.comet.length - 1].d);
    assert.ok(Math.abs(first[0] - tail.x) < 0.01 && Math.abs(first[1] - tail.y) < 0.01, `tail at ${t}`);
    assert.ok(Math.abs(last[2] - front.x) < 0.01 && Math.abs(last[3] - front.y) < 0.01, `head at ${t}`);
    frame.comet.slice(1).forEach((segment, i) => {
      const prev = coords(frame.comet[i].d);
      const next = coords(segment.d);
      assert.ok(Math.abs(prev[2] - next[0]) < 0.01 && Math.abs(prev[3] - next[1]) < 0.01, `joint ${i} at ${t}`);
    });
  }
});

test("the head is full strength in front of the globe and dimmed behind it", () => {
  const opacities = new Set<number>();
  for (let t = 0; t < LOOP_SECONDS; t += 0.05) opacities.add(markFrame(t, VIEW_SIZE).head.opacity);
  assert.ok(opacities.has(1));
  assert.equal(opacities.size, 2);
});

test("every line is drawn in full, with no gap where it passes behind the globe", () => {
  for (const t of [0, 1.7, 3.0, 5.2]) {
    const frame = markFrame(t, VIEW_SIZE);
    for (const line of [...frame.latitudes, ...frame.meridians, frame.ring]) {
      assert.equal(segments(line.near) + segments(line.far), SAMPLES, `segments at ${t}`);
    }
  }
});

test("the strokes keep section f's widths, with their pixel minimums at small sizes", () => {
  const small = strokeWidths(16);
  // At 16 px one pixel is 3 viewBox units, so each minimum is a multiple of 3.
  assert.ok(Math.abs(small.rim - 3) < 1e-9);
  assert.ok(Math.abs(small.hairline - 3) < 1e-9);
  assert.ok(Math.abs(small.head - 6) < 1e-9);
  assert.ok(Math.abs(small.tail - 2.4) < 1e-9);
  assert.ok(Math.abs(small.headDot - 6) < 1e-9);

  // At 960 px every stroke is above its pixel minimum, so each one follows the globe's diameter.
  const large = strokeWidths(960);
  const diameter = 2 * GLOBE_RADIUS;
  assert.ok(Math.abs(large.hairline - diameter / 500) < 1e-9);
  assert.ok(Math.abs(large.head - diameter / 170) < 1e-9);
  assert.ok(Math.abs(large.headDot - diameter / 160) < 1e-9);
  assert.ok(Math.abs(large.tail - diameter / 600) < 1e-9);
});

test("a frame is a pure function of time", () => {
  assert.deepEqual(markFrame(3, 24), markFrame(3, 24));
});
