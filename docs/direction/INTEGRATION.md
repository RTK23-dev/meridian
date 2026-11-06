# Plugging direction into Meridian

Version 3, 2026-11-05 (codex `direction-codex@2`). How the [Viral Direction Framework](./VIRAL_DIRECTION_FRAMEWORK.md) and its code (`src/lib/meridian/direction/`)
connect to the rest of Meridian, step by step. Each step says what it changes, whether it changes an engine contract, whether it spends
money, and what the owner decides.

## 0. Where direction sits

Meridian has two ways to create on one backend (AGENTS.md): the research-led Factory and direct creation. Both reach the video engine with a
`ProductionRequest`. The engine "consumes a script; it never writes one from scratch" (Bible 1); its `write_script` stage writes one only for
a brief request, by copying a reference's structure. Direction is the creative layer in front of that:

```
 Create page (Orchestrator) or a Factory plan
        |
  direction run (lib/meridian/direction)      concepts -> tournament -> scripts -> checks -> swipe test
        |                                        model calls on the workspace budget, through the generation path
  a person reviews                               the concepts, the chosen script, its findings, its risky moments
        |
  ProductionRequest                              the chosen script as the request's script (write_script is skipped),
        |                                        or a brief with direction in the cookbook's script instruction
  the engine                                     voice, plan, produce, edit, compose, render, gates
        |
  watch test (proposed)                          a video-and-audio model watches the render
        |
  publish to a trial audience -> measure -> learn
```

## 1. Done in this change

No engine contract changed. No provider was called. No money was spent.

| Piece | Where |
| --- | --- |
| The framework, its evidence, this plan, the research programme | `docs/direction/` |
| The codex (`direction-codex@2`, with the 147 short-form lessons, `LESSONS_CROSSWALK.md`) and the checks: attention, craft, slop, facts, and the report with the two floors | `src/lib/meridian/direction/` |
| Direction as prompt text per role, inside the engine's cookbook limits | `directives.ts` (`directionDirectives`, `withDirection`) |
| Divergence and convergence: the creative deck, filters, diverse finalists, order-swapped tournament, Bradley-Terry, judge reliability | `concepts.ts`, `tournament.ts` |
| Four pinned prompts (version 2) and their answer contracts | `prompts.ts`, `answers.ts` |
| The content planner: calendar grids, jobs per content game, the bullseye mix, outliers, repost candidates, Lego variations, view ceilings | `plan.ts` |
| The pipeline, with a model port and a hard call limit | `pipeline.ts` |
| The live port over Meridian's generation path (budget hold, ledger, workspace key) | `live.server.ts`, called by the direction jobs since step 2 |
| The switch for cookbook scripts, off by default | `applyCookbook(build, resolved, { direction })` in `content-factory/cookbook-request.ts` |

Tests: 99 in the direction module, one in `cookbook-request.test.ts` and one in `cookbook-choice.test.ts`, all fixture-based.

## 2. Step 1: direction in every cookbook script (no contract change, no new spend)

**What.** `cookbook-choice.ts` calls `applyCookbook(build, resolved.resolved)`. Passing `{ direction: { niche, format, hookFamily } }` adds
the codex's script rules under the cookbook's own `script` instruction. The engine's `write_script` stage already sends that instruction to
`scriptwriter@3`, under the scriptwriter's own rules (rule 11), so the scriptwriter writes with the hook, retention, end, trust and
anti-slop rules. The cost is the extra input tokens of one Opus call, about 1,000 tokens per script.

**What it does not do.** The engine reads only the `script` instruction today (`jobs/handlers/write-script.ts`). The other roles' instructions
are carried on the request but not read, so `withDirection` is limited to `script` there.

**Switched on for every run** (owner decision 2026-11-04: all runs, not a challenger share). `applyRecordedCookbook`
(`content-factory/cookbook-choice.ts`) passes the direction for every cookbook run, with the codex format that matches the cookbook's
family (explainer, listicle, story). The stored request records it, because its instruction text names the codex version.

## 3. Step 2: scripts from the Create page (no contract change, spends money): built 2026-11-05

**Built.** Asked for on 2026-11-05 ("real tools for agents and users to generate a new script, several to choose between, and
regenerate"). What follows the list below is the plan it was built from; the differences are noted here.

- **The Scripts panel** (`src/components/create/create-scripts.tsx`), under a draft on the Create page, admins only. Write one script or
  2 to 4 options, with the video's job, niche, length and language; regenerate one with a note (a new version of the same concept) or
  ask for a new idea; use one as the draft's script. `?draft=<id>` reopens a draft and its scripts after a reload.
- **The service** (`direction/service.ts`, server functions in `direction/actions.ts`). A run is a queued job (`direction.write`,
  `direction.revise`) with one attempt, because it spends: the worker runs it once through `liveDirectionPort`, and a run that stops is
  shown as stopped, never retried by itself. One run at a time per draft. Write runs use `choose: "person"`: every finished script is an
  option, in concept-ranking order, and the final panel is skipped because a person chooses. The call limit is `18 + 7 × options`.
- **Choosing** writes the script's spoken beats as the draft's script lines (the engine then skips `write_script`) and one direction
  note (pictures, words on screen, sound, a borrowed opening to attach at publishing) as an instruction, and sets the draft's language.
  Choosing another script replaces both. A blocked script cannot be chosen, and a draft with script lines a person wrote refuses a
  chosen script rather than mixing them.
- **Storage**: `direction_runs` and `direction_scripts` (migration 0153), with the request as built, the record, every call and cost,
  every draft with its findings and swipe test, and each revision's parent.
- **Seats**: "Copy and scripts" writes and directs. "Second script writer" and "Script judge" are new Settings tasks; Auto is the copy
  model, and the run notes that one family wrote or judged (the plan's Auto was "the newest priced model of another family", but the
  catalogue gives no release date, so a newest model cannot be chosen without guessing).
- **Not yet**: dated trends from discovery data (a run is told of none, and may use none), and the brand voice profile (5a).
- **Agents**: the same server functions; and agent mode, free, in `scripts/direction/cli.ts` with the skill
  `.claude/skills/direction-scripts`: an agent acts as each role with the pinned prompts and is checked by the same checks.
- **Live**: no live run has been recorded. The first one, on a workspace with a model chosen, is the owner's to run (CLAUDE.md rule 5).

**The plan.** A server function (admin only, with the tenancy check, AGENTS.md rule 2) that builds a `DirectionRequest` from the draft
session and the brand, runs `runDirection` with `liveDirectionPort`, stores the run (the direction record, framework 12.4) and shows it:

- The input: the session's messages and file notes as the brief; the brand brain's approved claims and prohibited words; the brand's recent
  hooks (`content-factory/hook-history-store.ts`); dated trends from discovery data.
- The slots: `writer_a` is the workspace's model for "Copy and scripts"; `writer_b` and `judge` are models of other families, chosen in
  Settings, with Auto resolving to the newest priced model of another family in the live catalogue (AGENTS.md rule 5).
- The screen: the ranked concepts and the dropped ones with their reasons; the chosen script as a timeline with its findings and the swipe
  test's risky moments; and buttons to accept it, take another finalist, or run again. A run that is `needs_person` says why.
- Accepting builds a `ProductionRequest` with the chosen script's beats (the engine then skips `write_script`).

**Cost (estimate, `hypothesis`).** With the default settings (3 concept calls, 18 concepts, 2 opponents, 2 finalists, at most 2 revisions,
40 calls at most), Opus-class writing and a Sonnet-class judge at the rates in Bible 11.1: about $0.20 for the concept lab, $0.15 for the
tournament, $0.35 for the scripts, $0.17 for the swipe tests and $0.03 for the final panel: under $1 a run at most. The ledger records the
real cost of every call.

**Owner decides:** the default families of the second writer and the judge (today: Auto is the copy model), and whether members as well
as admins may start a run (today: admins only, like every Content Factory action).

## 4. Step 3: the engine reads direction (some contract changes, for approval)

**3a. Without a contract change.** New prompt versions that read the cookbook instruction of their own role as data, as `scriptwriter@3`
does: `planner@2` and `director_check@3` read `visual` and `plan`; `critic_final@2` reads `critic`. The instructions are already in the
request contract (v13). Then `withDirection` can fill every role.

**3b. Contract v15 (proposal; needs the owner's or lead's approval, a version bump and a Bible section 4 note):**

1. `ProductionRequest.direction`, optional: the codex version, the run id, the concept id, the hook family, the format, the feeling, the send
   trigger, the rewatch device, the promise and its paying beat, and the loops. The engine carries it to the manifest and the learning
   events, so outcomes can be joined to creative choices.
2. A `watch_test` role in `post_render_review`: a model that takes the rendered video with its audio (Gemini-class native video models lead
   the documented long-video benchmarks; Claude sees frames, Bible 20.1), and scores the Lean-In rubric's stop, promise, gap, payoff and
   rewatch dimensions on the render, with evidence. Warn-only until its gold set meets Bible 12.4's targets.
3. A `direction.decided` event in `engine_events` (Bible 16.1), with the direction record.
4. A borrowed-clip asset (owner decision 2026-11-04 allows a clip-stitch opening). Today the engine never renders another creator's
   footage: Bible principle 4 keeps source footage out of a render, and reference media is deleted after analysis. To render a borrowed
   opening, the engine needs an asset kind for a credited clip of at most 5 seconds, with its source, its credit and a rights record (the
   maker allows stitching or remixing, or a licence), drawn as the first shot with the credit overlaid by code; plus a Bible note on
   principle 4. Until it is built, a direction run can plan the clip-stitch opening, and the clip is attached at publishing with the
   platform's own Stitch or Remix feature, or by a person.

## 5. Step 4: learning (no contract change beyond 3b)

1. Join each published video's direction record to its measured results (Meridian's measurement and learning modules): chose-to-view,
   3-second retention, average watch percentage, replays, sends per reach, saves.
2. Fit, nightly and within Bible 16.3's limits: the hook-family priors per niche and format, the rubric weights, the timing windows.
3. Calibrate the swipe tester on gold pairs (an outlier and a median video of the same creator). Until its pairwise accuracy is above the
   target (framework 13, initial 65%), its ranking does not choose without a person.
4. Test hook variants of one master on trial audiences, and let the results, not the critic, pick winners (the LOLA result).

## 5a. Proposed next roles and inputs (codex 2; no contract change)

- **A brand voice profile.** Three short texts kept with the brand brain (how the brand talks: voice, pace, rhythm, metaphors; how it
  works: rules for messages and answers; who it is: background and milestones), sent with every direction prompt as Meridian's own block.
  It lets direction write in the brand's voice instead of a generic one (lesson 140).
- **A script coach.** A direction prompt that reads the brand's five worst and five best scripts, with their results, and returns three to
  five concrete changes (lessons 133, 138, 139). It needs the learning loop's join of scripts to results first.
- **Conversational ideation.** A concept-lab card that carries one top reference and asks what its maker missed or got wrong (lesson 74).
- **The planner in the Create page.** A content plan of subtopics, formats and layouts, with a job per slot, that a person approves; each
  slot then starts a direction run with its job.

## 6. Changes proposed to existing modules (not made here)

These touch the study framework that the genome role and JEV questions read; AGENTS.md rule 6 keeps them for the owner:

- **Angle Bible, `continuous-open-loop`:** its mechanism names the Zeigarnik effect, which a 2025 meta-analysis did not support for memory.
  Proposed: "curiosity about a promised answer, and the tendency to resume an interrupted task (Ovsiankina)".
- **Angle Bible, `relational-tag-bait`:** "Tag your friend who..." is the engagement bait Meta demotes. Proposed: keep the share trigger
  (a habit two people share) and drop the tag request.
- **Angle Bible entries:** add the codex's 27 hook families as entries, and replace the flat `predictiveWeight: 1.0` with weights fitted in
  step 4.
- **Engine configuration:** move `DIRECTION_WINDOWS` into `engine/config/thresholds.ts` when an engine stage reads them (Bible 0: numbers
  live in configuration).

## 7. Decisions for the owner

1. ~~Step 1: switch direction on for cookbook scripts.~~ Decided 2026-11-04: on for all runs, and built.
2. ~~Step 2: allow direction runs from the Create page.~~ Asked for 2026-11-05, and built. Open: the default second-writer and judge
   families, and whether members may start a run.
3. Step 3b: approve contract v15 (direction on the request, the watch-test role, the direction event).
4. Section 6: the Angle Bible corrections.
5. Contract item 4: build the borrowed-clip asset, so the engine can render a clip-stitch opening itself.
6. A monthly budget for live tests (trial reels or small paid hook tests). Only real viewers decide winners.
7. Reference reels or account data for the gold set (the October note's Q7).
