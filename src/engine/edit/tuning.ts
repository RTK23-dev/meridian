// Editor capabilities and types. The 8.2 numbers the editor uses moved to config/thresholds.ts (thresholds.editor, thresholds@3),
// and the editor, the snap helpers, the geometry and the rules read them from there. What is left here is what the compiler can
// draw (compose/compiler.ts), and the caption band type derived from the configured band tops.

import { thresholds } from "../config/thresholds.ts";

export const EDIT_TUNING = {
  // Transitions and effects the compiler draws (compose/compiler.ts). speed_ramp and zoom transitions are refused there.
  drawableTransitions: ["hard", "fade", "whip"],
  drawableEffects: ["punch_in", "shake", "flash"],
} as const;

export type CaptionBand = keyof typeof thresholds.editor.geometry.captionTopShare;
