// Prop sets for title.hook: pop in the middle band, slide in the upper band, fade in the lower band.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "pop-middle",
    durationMs: 2500,
    props: {
      text: "Your kitchen counter is lying to you.",
      emphasis: ["lying"],
      entrance: "pop",
      entranceMs: 250,
      band: "middle",
    },
    framesMs: [900],
  },
  {
    name: "slide-upper",
    durationMs: 1800,
    props: {
      text: "Stop scrolling now",
      emphasis: ["now"],
      entrance: "slide",
      entranceMs: 300,
      band: "upper",
    },
    framesMs: [600],
  },
  {
    name: "fade-lower",
    durationMs: 2000,
    props: {
      text: "Three steps, zero clutter",
      emphasis: ["Three", "zero"],
      entrance: "fade",
      entranceMs: 400,
      band: "lower",
    },
    framesMs: [700],
  },
];
