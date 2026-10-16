// Prop sets for product.card. The hero URI in the first set is a placeholder image supplied by the golden-frame
// harness (a plain test image, not product photography). The other sets show the card without an image.

import type { ComponentFixture } from "../../../library.ts";

export const GOLDEN_HERO_URI = "store://golden/hero-placeholder.png";

export const fixtures: ComponentFixture[] = [
  {
    name: "hero-with-price",
    durationMs: 3000,
    props: {
      name: "Fixture Blender",
      bullets: ["Four smoothies", "Under two minutes", "Fits the counter"],
      price: "$49",
      heroUri: GOLDEN_HERO_URI,
    },
    framesMs: [1500],
  },
  {
    name: "text-two-bullets",
    durationMs: 2400,
    props: {
      name: "Blender Pro",
      bullets: ["Crushes ice", "Quiet motor"],
    },
    framesMs: [1200],
  },
  {
    name: "name-only",
    durationMs: 1600,
    props: {
      name: "Smoothie Cup",
      bullets: [],
    },
    framesMs: [800],
  },
];
