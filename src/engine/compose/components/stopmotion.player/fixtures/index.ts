// Prop sets for stopmotion.player. Each list is the count its clip needs at its fps (framesNeeded), so the props accept it:
// the Bible's 24 frames at 8 fps for three seconds, 25 frames at 10 fps for two and a half seconds, and the 36-frame ceiling at
// 12 fps for three seconds. Frames are placeholders named frame-01 and up; the golden harness draws each one in its own colour,
// so a late or early frame shows as a different colour. Each fixture's sourceUris is its own frame list (the shot's takes).

import type { ComponentFixture } from "../../../library.ts";

function framesOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `store://golden/frame-${String(index + 1).padStart(2, "0")}.png`);
}

const twentyFour = framesOf(24);
const twentyFive = framesOf(25);
const thirtySix = framesOf(36);

export const fixtures: ComponentFixture[] = [
  {
    name: "eight-fps-three-seconds",
    durationMs: 3000,
    props: { fps: 8, frameUris: twentyFour },
    sourceUris: twentyFour,
    framesMs: [60, 1060, 2940],
  },
  {
    name: "ten-fps-two-and-a-half-seconds",
    durationMs: 2500,
    props: { fps: 10, frameUris: twentyFive },
    sourceUris: twentyFive,
    framesMs: [50, 1050, 2450],
  },
  {
    name: "twelve-fps-max-frames-three-seconds",
    durationMs: 3000,
    props: { fps: 12, frameUris: thirtySix },
    sourceUris: thirtySix,
    framesMs: [40, 955, 2960],
  },
];
