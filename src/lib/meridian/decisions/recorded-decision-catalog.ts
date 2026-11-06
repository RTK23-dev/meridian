import { sourceFile } from "../../../engine/source-file.ts";
import { DecisionCatalogSource } from "./decision-catalog.ts";

/**
 * The OpenRouter decision catalogue as it was read on 2026-10-25 (GET /api/v1/models?output_modalities=decisions). Tests give this to
 * every decision engine they build, so none of them reaches the network. The recorded body is data only: no key, no workspace data.
 */
const recordedBody = sourceFile(
  import.meta.url,
  "./fixtures/openrouter-decisions-catalog-2026-10-25.json",
  "src/lib/meridian/decisions/fixtures/openrouter-decisions-catalog-2026-10-25.json",
);

/** The recorded body, parsed. Read on first use, never at module load: the settings page imports this module (source-file.ts). */
export function recordedDecisionCatalogBody(): unknown {
  return JSON.parse(recordedBody());
}

/** A catalogue source that answers from the recorded body. */
export function recordedDecisionCatalogSource(): DecisionCatalogSource {
  return new DecisionCatalogSource({
    fetchImpl: (async () =>
      new Response(JSON.stringify(recordedDecisionCatalogBody()), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    now: () => Date.parse("2026-10-25T06:00:00.000Z"),
  });
}
