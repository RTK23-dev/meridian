// Prop sets for captions.karaoke: lower band, middle band with a mid-word highlight, upper band with punctuation.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "lower-three-words",
    durationMs: 3000,
    props: {
      band: "lower",
      captions: [
        {
          startMs: 0,
          endMs: 1200,
          words: [
            { text: "Your", startMs: 0, endMs: 300 },
            { text: "counter", startMs: 300, endMs: 800 },
            { text: "lies", startMs: 800, endMs: 1200 },
          ],
        },
        {
          startMs: 1200,
          endMs: 2400,
          words: [
            { text: "Most", startMs: 1200, endMs: 1500 },
            { text: "people", startMs: 1500, endMs: 2000 },
            { text: "clear", startMs: 2000, endMs: 2400 },
          ],
        },
      ],
    },
    framesMs: [500],
  },
  {
    name: "middle-two-words",
    durationMs: 1500,
    props: {
      band: "middle",
      captions: [
        {
          startMs: 0,
          endMs: 900,
          words: [
            { text: "Stop", startMs: 0, endMs: 400 },
            { text: "scrolling", startMs: 400, endMs: 900 },
          ],
        },
      ],
    },
    framesMs: [600],
  },
  {
    name: "upper-punctuation",
    durationMs: 2000,
    props: {
      band: "upper",
      captions: [
        {
          startMs: 0,
          endMs: 1500,
          words: [
            { text: "Send", startMs: 0, endMs: 500 },
            { text: "BLEND", startMs: 500, endMs: 1000 },
            { text: "today.", startMs: 1000, endMs: 1500 },
          ],
        },
      ],
    },
    framesMs: [750],
  },
];
