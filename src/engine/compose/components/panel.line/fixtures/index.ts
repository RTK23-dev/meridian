// Prop sets for panel.line: a weekly rise, a dip and a recovery, and a flat line (every point equal, so the scale is the value itself).

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "weekly-rise",
    durationMs: 2600,
    props: {
      title: "Sign-ups",
      points: [
        { label: "Mon", value: 40 },
        { label: "Tue", value: 55 },
        { label: "Wed", value: 90 },
        { label: "Thu", value: 130 },
        { label: "Fri", value: 180 },
      ],
    },
    framesMs: [1800],
  },
  {
    name: "dip-and-recover",
    durationMs: 2600,
    props: {
      title: "Watch time",
      points: [
        { label: "1", value: 80 },
        { label: "2", value: 60 },
        { label: "3", value: 30 },
        { label: "4", value: 45 },
        { label: "5", value: 70 },
        { label: "6", value: 95 },
      ],
    },
    framesMs: [1500],
  },
  {
    name: "flat-line",
    durationMs: 1800,
    props: {
      title: "Stock",
      points: [
        { label: "Start", value: 3 },
        { label: "End", value: 3 },
      ],
    },
    framesMs: [900],
  },
];
