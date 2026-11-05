# Direction

The machine-readable part of the [Viral Direction Framework](../../../../docs/direction/VIRAL_DIRECTION_FRAMEWORK.md): what separates a
video people swipe past from one they hold closer, watch twice and send. Pure modules unless the name ends in `.server.ts`; nothing here
calls a provider except through the port the caller passes in.

Read in this order:

| File | What it is |
| --- | --- |
| `codex.ts` | The codex, version `direction-codex@2`: timing windows, hook families, formats on the format pyramid, feelings, share triggers, rewatch devices, the Lean-In rubric, hook anatomy (the triple hook, power words, trust anchors), lock-in approaches, villains, save and comment devices, video jobs and content games, the rules per area, the AI weak spots and the niche defaults. Every entry carries its evidence label. Version 2 adds the 147 short-form lessons mapped in [`LESSONS_CROSSWALK.md`](../../../../docs/direction/LESSONS_CROSSWALK.md). |
| `script.ts` | A directed script: the beat timeline with voice, on-screen text, picture, sound and link, and the structure the writer declares (promise, loops, feeling, send trigger, rewatch device; from version 2 the topic, job, lock-in, trust anchor, villain, ahas, rehooks and call to action). |
| `attention.ts` | The timeline and the attention checks: hook first and in time, promise paid late, loops closed, no long stretch, rates, specificity. |
| `slop.ts` | The slop lexicon: preambles, outros, engagement bait, stock hooks, the AI register, the not-X-but-Y turn, long dashes. English only; another language is reported as not checked. |
| `craft.ts` | The version 2 checks: context first, opening overload, if-then hooks, the double hook and the hourglass, zig-zag rhythm, reading level, text-hook style, lock-in and trust-anchor position, villain, double aha, hook sound, call-to-action alignment. |
| `facts.ts` | Length limit, forbidden terms, and numbers the brief does not give. |
| `report.ts` | All of the above in one report, with the trust and originality floors. |
| `directives.ts` | The codex as prompt text per role, and `withDirection`, which adds it to a cookbook's instructions inside the engine's limits. |
| `concepts.ts`, `random.ts` | Divergence: the creative deck, the concept lab's contract, the obvious/history/duplicate filters, diverse finalists. |
| `tournament.ts` | Convergence: order-swapped pairwise judging, Bradley-Terry ranking, judge reliability. |
| `prompts.ts`, `answers.ts` | The four direction prompts (pinned; `script_director@3` adds the person's note on a revision) and the panel and swipe-test answer contracts. |
| `pipeline.ts` | The whole run with an injected model port and a hard call limit. `choose: "person"` returns every finished script as an option; `reviseDirectedScript` regenerates one with a note. |
| `plan.ts` | The content planner: calendar grids, jobs per content game, the bullseye mix, outliers, repost candidates, Lego variations, view ceilings. |
| `live.server.ts` | The live port over Meridian's generation path (budget hold, ledger, workspace key). |
| `seats.ts` | Which model sits in each seat: the copy model writes and directs; the second writer and the judge are Settings tasks whose Auto is the copy model. |
| `service.ts`, `actions.ts`, `input.ts` | Scripts for a draft: ask for 1 to 4 options or a revision (a queued job, run once, `direction.write` and `direction.revise`), read the panel, choose a script (its lines become the draft's script lines). Admins of the draft's workspace only. Migration 0153. |
| `scripts-view.ts` | What a person sees of a script, and what choosing it writes: the script lines and the direction note. |
| `agent-tools.ts`, `lists.ts` | Agent mode (`scripts/direction/cli.ts`, skill `.claude/skills/direction-scripts`): the role messages, the filters and the checks, with no provider call. `lists.ts` holds the id lists a page reads. |

Tests: `NODE_ENV=development node --experimental-strip-types --test src/lib/meridian/direction/*.test.ts`. No test calls a live API.

What is wired: every cookbook run adds the script direction to the engine's cookbook reference (`applyRecordedCookbook`), which the
engine's write_script stage sends to the scriptwriter; and the Create page's Scripts panel writes, regenerates and chooses scripts for a
draft (step 2). The plan for the rest is in [`INTEGRATION.md`](../../../../docs/direction/INTEGRATION.md).
