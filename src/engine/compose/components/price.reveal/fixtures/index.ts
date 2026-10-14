// Prop sets for price.reveal: an old and a new USD price with a caption (frames before and after the reveal), a EUR
// price with cents and no old price, and a JPY price with a long amount (no fraction digits).

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "old-and-new-usd",
    durationMs: 2400,
    props: {
      currency: "USD",
      oldAmountMinor: 12900,
      newAmountMinor: 9900,
      revealMs: 800,
      caption: "Today only",
    },
    framesMs: [400, 1600],
  },
  {
    name: "eur-new-only-cents",
    durationMs: 1800,
    props: {
      currency: "EUR",
      newAmountMinor: 4999,
      revealMs: 500,
    },
    framesMs: [1200],
  },
  {
    name: "jpy-large",
    durationMs: 2000,
    props: {
      currency: "JPY",
      oldAmountMinor: 1290000,
      newAmountMinor: 1080000,
      revealMs: 600,
    },
    framesMs: [1200],
  },
];
