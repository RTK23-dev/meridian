# Orchestrator

The orchestrating model (chosen by the user) reads the whole brief and returns a graph of steps. Each step names a live model from the
OpenRouter catalog, or no model for a step that makes no model call. The engine checks the plan, prices it, runs it in order, and
re-runs only the steps a change touches.

Read in this order: `contracts.ts` (what a plan is), `validate.ts` (what is refused and why), `dirty.ts` (what a change re-runs),
`execute.ts` (how a run goes, including pause and not-connected), `layout.ts` and `replay.ts` (what the canvas draws).

Nothing here calls a provider. Handlers are passed in, and the gateway (`../gateway`) makes every call when they are wired.
