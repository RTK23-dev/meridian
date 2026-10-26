/** The three separate states of the OpenRouter engine. Saving a key, passing the test and being the active engine are not one thing. */
export type EngineStep = { id: "saved" | "tested" | "active"; label: string; done: boolean };

export type EngineProgress = {
  steps: EngineStep[];
  /** The one next thing to do, in a sentence. */
  next: string;
  /** Which engine receives decisions right now. */
  activeLabel: string;
};

export function openRouterProgress(input: { keySaved: boolean; testPassed: boolean; active: boolean; activeLabel: string }): EngineProgress {
  const steps: EngineStep[] = [
    { id: "saved", label: "Key saved", done: input.keySaved },
    { id: "tested", label: "Connection test passed", done: input.testPassed },
    { id: "active", label: "OpenRouter is the active engine", done: input.active },
  ];
  const next = !input.keySaved
    ? "Save your OpenRouter key below."
    : !input.testPassed
      ? "Test the connection below. Saving a key does not switch the engine."
      : !input.active
        ? `Choose "Use this engine". Until then ${input.activeLabel} receives every decision.`
        : "Nothing more to do. OpenRouter receives decisions.";
  return { steps, next, activeLabel: input.activeLabel };
}

/** Whether a blocker text is the missing monthly budget, and whether it says nothing was sent. The claim is made only when the text makes it. */
export function budgetBlocker(text: string): { blocked: boolean; nothingSent: boolean } {
  return { blocked: /monthly budget/i.test(text), nothingSent: /nothing was sent/i.test(text) };
}

/**
 * The same three states for TypeSafe JEV and OpenAI Decisions. Their readiness is a check of what is saved, not a request to the
 * provider, so the middle step says so and never claims a live test.
 */
export function savedKeyEngineProgress(input: { engineLabel: string; keySaved: boolean; ready: boolean; active: boolean; activeLabel: string }): EngineProgress {
  const steps: EngineStep[] = [
    { id: "saved", label: "Key saved", done: input.keySaved },
    { id: "tested", label: "Configuration checked (no request sent to the provider)", done: input.ready },
    { id: "active", label: `${input.engineLabel} is the active engine`, done: input.active },
  ];
  const next = !input.keySaved
    ? `Save your ${input.engineLabel} key below.`
    : !input.ready
      ? "The key is saved, but this engine is not ready. The reason is shown above."
      : !input.active
        ? `Choose "Use this engine". Until then ${input.activeLabel} receives every decision.`
        : `Nothing more to do. ${input.engineLabel} receives decisions.`;
  return { steps, next, activeLabel: input.activeLabel };
}
