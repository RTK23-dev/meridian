// Prop sets for stat.counter: a whole count, a decimal with a suffix, and a count with a prefix.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  { name: "cars-counted", durationMs: 2400, props: { value: 414, label: "Cars counted" }, framesMs: [1800] },
  { name: "percent-decimal", durationMs: 2000, props: { value: 25.5, decimals: 1, suffix: "%", label: "In 3 days" }, framesMs: [1500] },
  { name: "money-prefix", durationMs: 2200, props: { value: 1200, prefix: "$", label: "Per week" }, framesMs: [1600] },
];
