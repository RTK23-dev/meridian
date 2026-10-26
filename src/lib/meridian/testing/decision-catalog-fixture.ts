import { readFileSync } from "node:fs";
import { DecisionCatalogSource } from "../decisions/decision-catalog.ts";

/**
 * The OpenRouter decision catalogue as it was read on 2026-10-25 (GET /api/v1/models?output_modalities=decisions). Tests give this to
 * every decision engine they build, so none of them reaches the network. The recorded body is data only: no key, no workspace data.
 */
export const RECORDED_DECISION_CATALOG_BODY: unknown = JSON.parse(
  readFileSync(new URL("../decisions/fixtures/openrouter-decisions-catalog-2026-10-25.json", import.meta.url), "utf8"),
);

/** A catalogue source that answers from the recorded body. */
export function recordedDecisionCatalogSource(): DecisionCatalogSource {
  return new DecisionCatalogSource({
    fetchImpl: (async () =>
      new Response(JSON.stringify(RECORDED_DECISION_CATALOG_BODY), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    now: () => Date.parse("2026-10-25T06:00:00.000Z"),
  });
}
