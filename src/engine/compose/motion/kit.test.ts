import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { KIT_CURVES, MOTION_KIT_PATH, motionKitSource, bez, curve, dur, react } from "./kit.ts";
import { MOTION_REGISTERS, REGISTER_PROFILES, registerForFeeling } from "./registers.ts";

type Kit = { LIB: Record<string, ((p: number) => number) & { points: number[] }>; dur: (px: number, w?: number) => number; react: (i: number, s?: number) => number };

/** The vendored kit, evaluated as a browser would: it only needs `window` to load. */
function loadKit(): Kit {
  const window: { MotionKit?: Kit } = {};
  runInNewContext(motionKitSource(), { window });
  assert.ok(window.MotionKit, "motion-kit.js sets window.MotionKit");
  return window.MotionKit;
}

describe("the vendored motion kit", () => {
  it("is the upstream file, unchanged", () => {
    const hash = createHash("sha256").update(readFileSync(new URL("./motion-kit.js", import.meta.url))).digest("hex");
    assert.equal(hash, "150fe5f887e0b2f9dd99e27d5ead142482ea359fd1bc95af850070dfffc22be6");
    assert.equal(MOTION_KIT_PATH, "lib/motion-kit.js");
    assert.match(readFileSync(new URL("./LICENSE", import.meta.url), "utf8"), /^MIT License/);
  });

  it("names exactly the curves KIT_CURVES holds, with the same control points", () => {
    const kit = loadKit();
    assert.deepEqual([...Object.keys(kit.LIB)].sort(), Object.keys(KIT_CURVES).sort());
    for (const [name, points] of Object.entries(KIT_CURVES)) assert.deepEqual([...kit.LIB[name]!.points], [...points], name);
  });

  it("eases, times and offsets the same in TypeScript as in the browser", () => {
    const kit = loadKit();
    for (const name of ["kit.land", "kit.whip", "m3.emphasizedDecelerate", "easings.outBack"] as const) {
      for (const p of [0, 0.1, 0.33, 0.5, 0.77, 1]) assert.ok(Math.abs(curve(name)(p) - kit.LIB[name]!(p)) < 1e-9, `${name} at ${p}`);
    }
    for (const px of [0, 24, 90, 400, 1080]) for (const w of [0.7, 1, 1.35]) assert.equal(dur(px, w), kit.dur(px, w));
    for (let i = 0; i < 9; i++) assert.equal(react(i), kit.react(i));
    assert.equal(react(2, 2), kit.react(2, 2));
  });

  it("solves a bezier to its ends, and a decelerating curve front-loads its travel", () => {
    const land = bez(0.1, 0.75, 0.15, 1);
    assert.equal(land(0), 0);
    assert.equal(land(1), 1);
    assert.ok(land(0.3) > 0.7, "kit.land covers most of the travel early");
    assert.ok(curve("kit.heavy")(0.2) < 0.1, "kit.heavy pushes off slowly");
    assert.ok(dur(1080, 1.35) > dur(24, 0.7), "a heavy move across the frame takes longer than a light nudge");
  });
});

describe("motion registers", () => {
  it("every register names curves the kit has", () => {
    for (const register of MOTION_REGISTERS) {
      const profile = REGISTER_PROFILES[register];
      for (const name of [profile.arrive, profile.weighty, profile.snap]) assert.ok(name in KIT_CURVES, `${register}: ${name}`);
      assert.ok(profile.damping > 0.5 && profile.damping <= 1);
    }
  });

  it("a feeling suggests a register; an unknown feeling reads as editorial", () => {
    assert.equal(registerForFeeling("awe"), "premium");
    assert.equal(registerForFeeling("amusement"), "playful");
    assert.equal(registerForFeeling("tension"), "expressive");
    assert.equal(registerForFeeling("relief"), "calm");
    assert.equal(registerForFeeling("unknown"), "editorial");
    assert.equal(registerForFeeling(null), "editorial");
  });
});
