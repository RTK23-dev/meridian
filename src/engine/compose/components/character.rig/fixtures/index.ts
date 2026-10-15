// Prop sets for character.rig: an idle character talking (mouth shapes on the clock), a character pointing and cheering
// with a happy face, and a character who is annoyed, then surprised, with a grin at the start. Golden frames are taken with
// the mouth or pose in the state the timeline gives at that time.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "idle-talk",
    durationMs: 3000,
    props: {
      rigId: "bean.v1",
      characterId: "char_fixture",
      position: "center",
      poses: [{ atMs: 0, pose: "idle", expression: "neutral" }],
      mouth: [
        { atMs: 300, shape: "open" },
        { atMs: 480, shape: "closed" },
        { atMs: 560, shape: "wide" },
        { atMs: 760, shape: "closed" },
        { atMs: 840, shape: "round" },
        { atMs: 1000, shape: "closed" },
        { atMs: 1100, shape: "open" },
        { atMs: 1300, shape: "closed" },
        { atMs: 1400, shape: "wide" },
        { atMs: 1600, shape: "closed" },
      ],
    },
    framesMs: [700, 1250],
  },
  {
    name: "point-and-cheer",
    durationMs: 2800,
    props: {
      rigId: "bean.v1",
      characterId: "char_fixture",
      position: "right",
      poses: [
        { atMs: 0, pose: "idle", expression: "neutral" },
        { atMs: 600, pose: "point", expression: "happy" },
        { atMs: 1700, pose: "cheer", expression: "happy" },
      ],
      mouth: [
        { atMs: 700, shape: "open" },
        { atMs: 900, shape: "closed" },
        { atMs: 1000, shape: "open" },
        { atMs: 1200, shape: "closed" },
      ],
    },
    framesMs: [1000, 2100],
  },
  {
    name: "think-surprise",
    durationMs: 2400,
    props: {
      rigId: "bean.v1",
      position: "left",
      poses: [
        { atMs: 0, pose: "think", expression: "annoyed" },
        { atMs: 1200, pose: "surprise", expression: "surprised" },
      ],
      mouth: [
        { atMs: 0, shape: "teeth" },
        { atMs: 300, shape: "closed" },
        { atMs: 900, shape: "round" },
        { atMs: 1000, shape: "closed" },
      ],
    },
    framesMs: [600, 1500],
  },
];
