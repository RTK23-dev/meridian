// Prop sets for label.pill: a place with a date, a place alone, and a long place name with a date.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  { name: "berlin-date", durationMs: 2000, props: { place: "Berlin", date: "12 Oct 2026" }, framesMs: [1200] },
  { name: "place-only", durationMs: 1500, props: { place: "Lisbon" }, framesMs: [800] },
  { name: "long-place", durationMs: 1800, props: { place: "São Paulo, Brazil", date: "1 Nov 2026" }, framesMs: [900] },
];
