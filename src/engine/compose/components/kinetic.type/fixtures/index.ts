// Prop sets for kinetic.type: a stagger with an emphasis word on three lines, a pop entrance with an emphasis word in the
// upper band (wrapped), and one long line in the lower band. Golden frames are taken while a line is on screen.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "stagger-three-lines",
    durationMs: 2600,
    props: {
      lines: [
        { text: "Stop buying", atMs: 0 },
        { text: "the expensive blender", atMs: 900 },
        { text: "again.", atMs: 1800 },
      ],
      emphasis: ["expensive"],
      entrance: "stagger",
      wordStepMs: 120,
      band: "middle",
    },
    framesMs: [1200, 2200],
  },
  {
    name: "pop-emphasis-upper",
    durationMs: 2200,
    props: {
      lines: [
        { text: "Four smoothies in two minutes", atMs: 0 },
        { text: "Honestly?", atMs: 1200 },
      ],
      emphasis: ["two", "Honestly"],
      entrance: "pop",
      wordStepMs: 150,
      band: "upper",
    },
    framesMs: [400, 1500],
  },
  {
    name: "lower-band-long-line",
    durationMs: 2000,
    props: {
      lines: [{ text: "This is the part nobody shows you", atMs: 0 }],
      emphasis: [],
      entrance: "stagger",
      wordStepMs: 120,
      band: "lower",
    },
    framesMs: [1200],
  },
];
