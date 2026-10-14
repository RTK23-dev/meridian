// Prop sets for cta.card: a keyword with a down arrow, a text-only card with a right arrow, and an up arrow.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "down-with-keyword",
    durationMs: 3000,
    props: { text: "Send BLEND to get the link", keyword: "BLEND", arrow: "down" },
    framesMs: [1500],
  },
  {
    name: "right-text-only",
    durationMs: 2000,
    props: { text: "Tap the link in bio", arrow: "right" },
    framesMs: [1200],
  },
  {
    name: "up-keyword-long",
    durationMs: 2500,
    props: { text: "Comment SHOP for the offer", keyword: "SHOP", arrow: "up" },
    framesMs: [1800],
  },
];
