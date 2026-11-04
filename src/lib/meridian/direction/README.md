# Direction

The machine-readable part of the [Viral Direction Framework](../../../../docs/direction/VIRAL_DIRECTION_FRAMEWORK.md): what separates a
video people swipe past from one they hold closer, watch twice and send. Pure modules unless the name ends in `.server.ts`; nothing here
calls a provider except through the port the caller passes in.

Read in this order:

| File | What it is |
| --- | --- |
| `codex.ts` | The codex, version `direction-codex@1`: timing windows, hook families, formats, feelings, share triggers, rewatch devices, the Lean-In rubric, the rules per area, the AI weak spots and the niche defaults. Every entry carries its evidence label. |
| `script.ts` | A directed script: the beat timeline with voice, on-screen text, picture and link, and the structure the writer declares (promise, loops, feeling, send trigger, rewatch device). |
| `attention.ts` | The timeline and the attention checks: hook first and in time, promise paid late, loops closed, no long stretch, rates, specificity. |
| `slop.ts` | The slop lexicon: preambles, outros, engagement bait, stock hooks, the AI register, the not-X-but-Y turn, long dashes. English only; another language is reported as not checked. |
| `facts.ts` | Length limit, forbidden terms, and numbers the brief does not give. |
| `report.ts` | All of the above in one report, with the trust and originality floors. |
| `directives.ts` | The codex as prompt text per role, and `withDirection`, which adds it to a cookbook's instructions inside the engine's limits. |
| `concepts.ts`, `random.ts` | Divergence: the creative deck, the concept lab's contract, the obvious/history/duplicate filters, diverse finalists. |
| `tournament.ts` | Convergence: order-swapped pairwise judging, Bradley-Terry ranking, judge reliability. |
| `prompts.ts`, `answers.ts` | The four direction prompts (pinned) and the panel and swipe-test answer contracts. |
| `pipeline.ts` | The whole run with an injected model port and a hard call limit. |
| `live.server.ts` | The live port over Meridian's generation path (budget hold, ledger, workspace key). Not called anywhere yet. |

Tests: `NODE_ENV=development node --experimental-strip-types --test src/lib/meridian/direction/*.test.ts`. No test calls a live API.

What is wired: `applyCookbook(build, resolved, { direction })` (content-factory/cookbook-request.ts) adds the script direction to the
engine's cookbook reference, which the engine's write_script stage sends to the scriptwriter. It is off unless a caller passes
`direction`. The plan for the rest is in [`INTEGRATION.md`](../../../../docs/direction/INTEGRATION.md).
