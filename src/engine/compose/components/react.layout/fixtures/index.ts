// Prop sets for react.layout: an image base with the presenter at bottom right, a video presenter at top left that
// enters late, and a video base with the presenter at top right. The golden harness supplies placeholder media only:
// a plain gradient or a solid colour (no product or person photography).

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "image-base-bottom-right",
    durationMs: 2400,
    props: {
      baseUri: "store://golden/base.png",
      presenterUri: "store://golden/presenter.png",
      pip: "bottom-right",
      pipWidthPct: 34,
      pipInMs: 0,
    },
    framesMs: [1200],
  },
  {
    name: "video-presenter-top-left",
    durationMs: 2400,
    props: {
      baseUri: "store://golden/base.png",
      presenterUri: "store://golden/presenter.webm",
      presenterInMs: 500,
      pip: "top-left",
      pipWidthPct: 30,
      pipInMs: 600,
    },
    framesMs: [300, 1200],
  },
  {
    name: "video-base-top-right",
    durationMs: 2000,
    props: {
      baseUri: "store://golden/base.webm",
      baseInMs: 1000,
      presenterUri: "store://golden/presenter.png",
      pip: "top-right",
      pipWidthPct: 40,
      pipInMs: 800,
    },
    framesMs: [1500],
  },
];
