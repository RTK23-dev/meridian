// Prop sets for kinetic.punchline: three lines on a steady rhythm, two large lines, and one short line.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "three-lines-rhythm",
    durationMs: 2800,
    props: { lines: ["No clutter.", "One blender.", "Four smoothies."], rhythmMs: 800, scale: 1 },
    framesMs: [1000],
  },
  {
    name: "two-lines-large",
    durationMs: 2000,
    props: { lines: ["Wait for it", "Here it is"], rhythmMs: 900, scale: 1.2 },
    framesMs: [1300],
  },
  {
    name: "single-line-small",
    durationMs: 1200,
    props: { lines: ["Done."], rhythmMs: 600, scale: 0.9 },
    framesMs: [600],
  },
];
