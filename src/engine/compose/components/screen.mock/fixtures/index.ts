// Prop sets for screen.mock: a notification on a phone (with a placeholder icon), an app screen on a phone with four rows
// and a placeholder picture, and a chat on a desktop window whose message is markup, which must show as text. The pictures
// are placeholders in golden frames (test/golden/harness.ts), never product or person photography.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  {
    name: "notification-phone",
    durationMs: 2200,
    props: {
      device: "phone",
      screen: "notification",
      app: "Blendbar",
      title: "Your order is on its way",
      body: "Four smoothies in under two minutes. Tap to see the link.",
      timeLabel: "now",
      iconUri: "store://golden/hero.png",
      atMs: 500,
    },
    framesMs: [1100],
  },
  {
    name: "app-rows-phone",
    durationMs: 2800,
    props: {
      device: "phone",
      screen: "app",
      title: "Fixture Blender",
      rows: [
        { label: "Blend time", value: "2 min" },
        { label: "Jug size", value: "1.5 L" },
        { label: "Noise", value: "Quiet" },
        { label: "Warranty", value: "2 years" },
      ],
      imageUri: "store://golden/hero.png",
      atMs: 0,
      rowStepMs: 220,
    },
    framesMs: [900, 1500],
  },
  {
    name: "chat-desktop-markup",
    durationMs: 2800,
    props: {
      device: "desktop",
      screen: "chat",
      title: "@blendbar",
      messages: [
        { side: "left", text: "Is this blender loud?", atMs: 400 },
        { side: "right", text: "Not at all. <b>Four smoothies</b> in under two minutes.", atMs: 1200 },
        { side: "left", text: "Send me the link", atMs: 2000 },
      ],
    },
    framesMs: [1600, 2600],
  },
];
