# Orchestrator

The orchestrating model (chosen by the user) reads the whole brief and returns a graph of steps. Each step names a live model from the
OpenRouter catalog, or no model for a step that makes no model call. The engine checks the plan, prices it, runs it in order, and
re-runs only the steps a change touches.

Read in this order: `contracts.ts` (what a plan is), `validate.ts` (what is refused and why), `dirty.ts` (what a change re-runs),
`execute.ts` (how a run goes, including pause and not-connected), `layout.ts` and `replay.ts` (what the canvas draws).

Money is a soft limit (owner direction 2026-10-23). The plan's total has a target (the lower of the plan's budget and the budget the user set)
and an allowance (the target plus its tolerance, `budget/tolerance.ts`). A brief may also set a copy, a creative or a voice budget
(`categories.ts`): copy is the text steps, creative the image and video steps, voice the speech steps. A category the brief leaves unset is
split by the orchestrator under the total. A run pauses for an approval at the step that would pass the total's allowance or its category's
allowance; it never fails for a small overrun. A stored output keeps its category, so a later run totals each category from what is stored.

Nothing here calls a provider. Handlers are passed in, and the gateway (`../gateway`) makes every call when they are wired.
