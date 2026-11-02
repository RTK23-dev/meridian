// Prop sets for panel.bars: three bars, five decimal bars, and a single bar at zero (every bar at zero still draws, with the scale at one).

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "three-bars",
    durationMs: 2400,
    props: {
      title: "Cars per hour",
      bars: [
        { label: "Mon", value: 120 },
        { label: "Tue", value: 340 },
        { label: "Wed", value: 210 },
      ],
    },
    framesMs: [1600],
  },
  {
    name: "five-decimal",
    durationMs: 2000,
    props: {
      title: "Average rating",
      bars: [
        { label: "Week 1", value: 2.5 },
        { label: "Week 2", value: 3.1 },
        { label: "Week 3", value: 4.2 },
        { label: "Week 4", value: 4.6 },
        { label: "Week 5", value: 4.9 },
      ],
    },
    framesMs: [1200],
  },
  {
    name: "single-zero",
    durationMs: 1500,
    props: { title: "Sales", bars: [{ label: "Today", value: 0 }] },
    framesMs: [800],
  },
];
