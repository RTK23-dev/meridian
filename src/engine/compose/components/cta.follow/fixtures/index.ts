// Prop sets for cta.follow: a handle with the default prompt, a handle with its own prompt, and a long handle.

import type { ComponentFixture } from "../../../library.ts";

export const fixtures: ComponentFixture[] = [
  { name: "handle-default", durationMs: 2000, props: { handle: "@meridian" }, framesMs: [1200] },
  { name: "custom-prompt", durationMs: 2200, props: { handle: "@studio_one", prompt: "Follow for the next video" }, framesMs: [1400] },
  { name: "long-handle", durationMs: 1800, props: { handle: "@a_very_long_channel_name", prompt: "Follow" }, framesMs: [900] },
];
