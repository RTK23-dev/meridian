# Orchestrator

The orchestrating model (chosen by the user) reads the whole brief and returns a graph of steps. Each step names a live model from the
OpenRouter catalog, or no model for a step that makes no model call. The engine checks the plan, prices it, runs it in order, and
re-runs only the steps a change touches.

Read in this order: `contracts.ts` (what a plan is), `validate.ts` (what is refused and why), `dirty.ts` (what a change re-runs),
`execute.ts` (how a run goes, including pause and not-connected), `layout.ts` and `replay.ts` (what the canvas draws).

Money is a line (owner direction 2026-10-23, decision D12). The plan's total has one line: the lower of the plan's budget and the budget the
user set (`envelope.ts`). A brief may also set a copy, a creative or a voice budget (`categories.ts`), and each is a line of its own: copy is
the text steps, creative the image and video steps, voice the speech steps. A category the brief leaves unset is split by the orchestrator
under the total. A paid step starts only while the committed spend is below its line and its own hold fits within it (D17, `budget/line.ts`).
A step whose hold does not fit pauses the run before its call, and the project waits until an admin raises the budget. A call already in
flight finishes, so a bill above its estimate may take the spend past the line, and the overshoot is recorded. A plan whose estimate is above
its line is still accepted, with a note. A queued job's hold counts until its poll settles it (D14). A stored output keeps its
category, so a later run totals each category from what is stored.

Nothing here calls a provider. Handlers are passed in, and the gateway (`../gateway`) makes every call when they are wired.
