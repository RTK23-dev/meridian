/**
 * The OpenRouter test seam. Only the testing runtime (NODE_ENV=test, or MERIDIAN_TESTING_RUNTIME=true outside production) swaps
 * the live catalogue and the provider transport for recorded ones, so a browser run can walk the budget, model, test and engine
 * choice without a key, a network or spend. Outside the testing runtime it returns nothing, so production always reads the live
 * catalogue and sends real requests. The recorded answer is a fixture, not a verification of the provider.
 */
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { liveDecisionCatalog, type DecisionCatalogSource } from "./decision-catalog.ts";
import { recordedDecisionCatalogSource } from "../testing/decision-catalog-fixture.ts";

export type OpenRouterSeam = { catalog: DecisionCatalogSource; fetchImpl?: typeof fetch };

/** The recorded transport: one passing answer to the connection test. It makes no network request. */
const recordedTransport = (async () =>
  new Response(
    JSON.stringify({
      model: "typesafe/jev-1.14-20261014",
      provider: "TypeSafe",
      id: "gen-dec-recorded-1",
      answers: { connection_test: { type: "noul", noul: 0.95 } },
      usage: { input_tokens: 357, output_tokens: 38, cost: 0.0000149 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

/** The catalogue (and, in the testing runtime, the transport) the OpenRouter actions use. */
export function openRouterSeam(): OpenRouterSeam {
  if (!isTestingRuntimeNow()) return { catalog: liveDecisionCatalog };
  return { catalog: recordedDecisionCatalogSource(), fetchImpl: recordedTransport };
}
