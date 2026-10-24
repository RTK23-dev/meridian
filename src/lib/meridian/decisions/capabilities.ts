/**
 * What each decision engine can take, in one exhaustive table. Callers ask this instead of comparing an engine ID, so an engine's
 * image support is decided where its adapter is classified, and a new engine cannot quietly take the wrong branch: the table
 * must name every engine, or it does not compile.
 *
 * OpenRouter's verified decision models take images, but only some of them, so the per-decision check in the adapter (its
 * model's verified capabilities) is what actually decides. This table answers only whether the engine can take images at all.
 */
import type { DecisionEngineId } from "./types.ts";

const ACCEPTS_IMAGES: Record<DecisionEngineId, boolean> = {
  jev: false,
  "openai-decisions": true,
  "openrouter-decisions": true,
};

/** Whether the engine can take image evidence. A text-only engine gets the text evidence and records that no images were seen. */
export function engineAcceptsImages(engineId: DecisionEngineId): boolean {
  return ACCEPTS_IMAGES[engineId];
}
