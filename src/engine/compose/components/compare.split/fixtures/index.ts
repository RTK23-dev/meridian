// Prop sets for compare.split: two placeholder images with the right panel shown at once, a video on the right that
// wipes in late, and two text-only panels. The golden harness supplies placeholder media only.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "before-after-images",
    durationMs: 2000,
    props: {
      leftLabel: "Before",
      rightLabel: "After",
      leftUri: "store://golden/before.png",
      rightUri: "store://golden/after.png",
      revealMs: 0,
    },
    framesMs: [800],
  },
  {
    name: "after-wipes-in-video",
    durationMs: 2400,
    props: {
      leftLabel: "Before",
      rightLabel: "After",
      leftUri: "store://golden/before.png",
      rightUri: "store://golden/after.webm",
      revealMs: 700,
    },
    framesMs: [300, 1300],
  },
  {
    name: "text-only-panels",
    durationMs: 1600,
    props: {
      leftLabel: "Brand A",
      rightLabel: "Brand B",
      revealMs: 0,
    },
    framesMs: [800],
  },
];
