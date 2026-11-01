// Prop sets for panel.tiles: four tiles in two columns, six tiles in three, and a single tile.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "four-tiles",
    durationMs: 2200,
    props: {
      title: "This week",
      tiles: [
        { label: "Views", value: "1.2k" },
        { label: "Saves", value: "86" },
        { label: "Shares", value: "23" },
        { label: "Clicks", value: "9" },
      ],
    },
    framesMs: [1400],
  },
  {
    name: "six-tiles",
    durationMs: 2400,
    props: {
      title: "Results",
      tiles: [
        { label: "Cars", value: "414" },
        { label: "Hours", value: "38" },
        { label: "Days", value: "3" },
        { label: "Sites", value: "7" },
        { label: "Cities", value: "2" },
        { label: "Teams", value: "5" },
      ],
    },
    framesMs: [1500],
  },
  {
    name: "single-tile",
    durationMs: 1600,
    props: { title: "Price", tiles: [{ label: "Per month", value: "$9" }] },
    framesMs: [900],
  },
];
