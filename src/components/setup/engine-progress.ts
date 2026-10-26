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
