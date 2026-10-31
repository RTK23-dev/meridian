// The Meridian-owned look registry (contract v11). Every look a visual treatment can name, and the overlay each one draws, is defined
// here and nowhere else. A look is a preset name from LOOK_PRESETS, so the composition never receives CSS from the EDL.

import { EngineError, LOOK_PRESETS, type LookPreset } from "../contracts/index.ts";

export type LookOverlay = { color: string; blend: string; opacity: number };

/** The overlay of each look at full strength. The record's keys are the contract's looks, so a look without an overlay does not compile. */
export const LOOK_OVERLAYS: Record<LookPreset, LookOverlay> = {
  warm: { color: "#ff8c42", blend: "overlay", opacity: 0.45 },
  cool: { color: "#3d7bd9", blend: "overlay", opacity: 0.4 },
  faded: { color: "#d8cfc4", blend: "screen", opacity: 0.25 },
  mono: { color: "#808080", blend: "saturation", opacity: 1 },
};

/** Resolves a look name to its overlay, or refuses it. A name that is not a look is never drawn with a guessed overlay (fail closed). */
export function resolveLook(name: unknown): LookOverlay {
  if (typeof name === "string" && (LOOK_PRESETS as readonly string[]).includes(name)) return LOOK_OVERLAYS[name as LookPreset];
  throw new EngineError("invalid_input", `unknown look preset: ${String(name)}`, { stage: "compose" });
}
