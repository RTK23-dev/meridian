// Server only: whether an image model fits the per-call ceiling, for the model presets. It is kept out of model-presets.ts, which the
// Settings page loads in the browser, because the ledger's bound lives beside server code (providers/generation-ledger.ts).
import { boundGenerationCall } from "../providers/generation-ledger.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";

/** The output an image call is bounded at when a preset checks it against the per-call ceiling (perception asks for at most 2,000 tokens). */
export const PRESET_IMAGE_MAX_TOKENS = 2_000;

/**
 * Whether one image call to this model fits the per-call ceiling. An image call is bounded at the model's whole context (the listing
 * states no image tokens) plus the output limit, the same bound the call itself is checked against, so a model that does not fit would
 * be refused on every image call.
 */
export function imageCallFitsCeiling(model: Pick<TextModelChoice, "promptUsdPerToken" | "completionUsdPerToken" | "contextLength">, ceilingUsd: number): boolean {
  const bound = boundGenerationCall({ choice: model, system: "", user: [{ type: "image_url", image_url: { url: "data:image/png;base64," } }], maxTokens: PRESET_IMAGE_MAX_TOKENS });
  return bound.ok && bound.usd <= ceilingUsd;
}
