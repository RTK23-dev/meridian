import type { DecisionEngine } from "../decisions/types.ts";

/**
 * The OpenRouter Decisions engine in tests that do not select it. A call to it fails the test: a request that reaches this engine
 * is a request that should have gone to the engine the test selected.
 */
export function unselectedOpenRouterEngine(): DecisionEngine {
  return {
    id: "openrouter-decisions",
    adapterVersion: "openrouter-decisions-unselected.v1",
    capabilities: () => ({
      engineId: "openrouter-decisions",
      questionKinds: [],
      inputModalities: [],
      maxImages: 0,
      maxImageBytes: 0,
      imageMimeTypes: [],
      batchQuestions: false,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "NOT_CONFIGURED", message: "Not selected in this test." }),
    async decide() {
      throw new Error("The OpenRouter Decisions engine was called, but this test does not select it.");
    },
  };
}
