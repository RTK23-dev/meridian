// Prop sets for stopmotion.player: the Bible's 24 frames at 8 fps (three seconds), the 36-frame ceiling at 12 fps on a
// shorter clip (frames 24 to 35 start after the clip and are not shown), and an exact 20 frames at 10 fps. Frames are
// placeholders named frame-01 and up; the golden harness draws each one in its own colour, so a late or early frame
// shows as a different colour. Each fixture's sourceUris is its own frame list (the shot's takes).

import type { ComponentFixture } from "../../../library.ts";

function framesOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `store://golden/frame-${String(index + 1).padStart(2, "0")}.png`);
}

const twentyFour = framesOf(24);
const thirtySix = framesOf(36);
const twenty = framesOf(20);

export const fixtures: ComponentFixture[] = [
  {
    name: "eight-fps-three-seconds",
    durationMs: 3000,
    props: { fps: 8, frameUris: twentyFour },
    sourceUris: twentyFour,
    framesMs: [60, 1060, 2940],
  },
  {
    name: "twelve-fps-max-frames-clipped",
    durationMs: 2000,
    props: { fps: 12, frameUris: thirtySix },
    sourceUris: thirtySix,
    framesMs: [40, 955, 1960],
  },
  {
    name: "ten-fps-two-seconds",
    durationMs: 2000,
    props: { fps: 10, frameUris: twenty },
    sourceUris: twenty,
    framesMs: [50, 1050, 1950],
  },
];
