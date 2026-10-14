// Prop sets for list.tierBoard: three tiers with images and staggered drops, two text-only tiers, and one full row of
// four image cards. The golden harness supplies placeholder images only (no product photography).

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "three-tiers-with-images",
    durationMs: 3000,
    props: {
      title: "Best blenders",
      tiers: [
        { label: "S", tone: "accent" },
        { label: "A", tone: "primary" },
        { label: "B", tone: "secondary" },
      ],
      items: [
        { name: "Blender Pro", tier: 0, dropMs: 300, imageUri: "store://golden/item-pro.png" },
        { name: "Quiet One", tier: 0, dropMs: 700, imageUri: "store://golden/item-quiet.png" },
        { name: "Budget Mix", tier: 1, dropMs: 1100 },
        { name: "Mini Cup", tier: 2, dropMs: 1500, imageUri: "store://golden/item-mini.png" },
      ],
    },
    framesMs: [500, 2400],
  },
  {
    name: "text-only-two-tiers",
    durationMs: 2000,
    props: {
      tiers: [
        { label: "1", tone: "text" },
        { label: "2", tone: "primary" },
      ],
      items: [
        { name: "Smoothie", tier: 0, dropMs: 200 },
        { name: "Protein shake", tier: 0, dropMs: 400 },
        { name: "Iced tea", tier: 1, dropMs: 600 },
        { name: "Water", tier: 1, dropMs: 800 },
      ],
    },
    framesMs: [1500],
  },
  {
    name: "full-row-four-images",
    durationMs: 1800,
    props: {
      tiers: [{ label: "A", tone: "accent" }],
      items: [
        { name: "One", tier: 0, dropMs: 0, imageUri: "store://golden/item-one.png" },
        { name: "Two", tier: 0, dropMs: 200, imageUri: "store://golden/item-two.png" },
        { name: "Three", tier: 0, dropMs: 400, imageUri: "store://golden/item-three.png" },
        { name: "Four", tier: 0, dropMs: 600, imageUri: "store://golden/item-four.png" },
      ],
    },
    framesMs: [1200],
  },
];
