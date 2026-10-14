// Prop sets for chat.thread: a three-message exchange with typing (a frame while the reply is typed, and one after it
// lands), a long message with an unbroken link, and a message whose text is markup. The markup must show as text.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "dm-exchange",
    durationMs: 4000,
    props: {
      header: "@blendbar",
      messages: [
        { side: "left", text: "Is this blender loud?", atMs: 600 },
        { side: "right", text: "Not at all. Four smoothies in under two minutes.", atMs: 1900, typingMs: 900 },
        { side: "left", text: "Send me the link", atMs: 2900, typingMs: 800 },
      ],
    },
    framesMs: [1500, 3300],
  },
  {
    name: "long-message-link",
    durationMs: 2400,
    props: {
      messages: [
        {
          side: "left",
          text: "Here is the full breakdown of every setting, with the link https://example.com/very/long/link/that/does/not/break/on/spaces/at/all",
          atMs: 500,
        },
        { side: "right", text: "Thanks", atMs: 1400, typingMs: 500 },
      ],
    },
    framesMs: [1800],
  },
  {
    name: "escaped-markup",
    durationMs: 2000,
    props: {
      header: "@escape_test",
      messages: [
        { side: "left", text: "<b>Bold?</b> & <img src=x onerror=alert(1)>", atMs: 400 },
        { side: "right", text: "Shown as text: \"quoted\" and 'single'", atMs: 1000 },
      ],
    },
    framesMs: [1500],
  },
];
