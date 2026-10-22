# Content Factory: where it stands, and the hot swap (2026-10-18)

This is a state record, not a plan. It says what is built and where, what a reviewer can do now, and what is still open. Everything
described as built is verified on recorded fixtures only. No live provider has been called, and no key has been used.

## 1. What the Content Factory is

Two parts, one page.

- **The engine** (`src/engine/`, governed by the Video Engine Bible inside that folder). A request is a production job: a reference
  video, a brief or a script, a product, a page's kits and a budget. The orchestrator (`engine/jobs/orchestrator.ts`) is a pure state
  machine: `advance(state, event)` returns the next state, the jobs ready to queue, and the effects to store. The stages (`engine/jobs/registry.ts`)
  run as jobs on Meridian's Postgres queue: intake, analyze_reference, write_script, voice, plan, estimate_reserve, produce_shot, check_take,
  edit, compose, pre_render_gate, render, post_render_review, variants, deliver. Each stage writes one typed artifact, and a gate decides
  what runs next.
- **The page** (`/content-factory`, admin only; `src/routes/_app/content-factory.tsx`). A chat-style session: instructions, files from the
  computer, and records from Meridian's own pages. "Make the video" builds the request and starts it through the engine's API. The page
  then shows the run.

## 2. What is built

| Area | State | Where |
| --- | --- | --- |
| Contracts | `engine-contracts@9`. Settlement (v6), model choice on asset specs (v7), brief requests and `write_script` (v8), `providerRef` and held-call reconciliation (v9) | `src/engine/contracts/`, Bible section 4 |
| Orchestrator and queue | Event-sourced state machine, scheduler, redo and downgrade rules, escalation to a person, variants as runs | `src/engine/jobs/orchestrator.ts`, `orchestrator-sql.ts`, `runtime.ts` |
| Reference analysis | ffmpeg on the worker, Deepgram speech-to-text, Claude roles for segments and genome | `src/engine/analyze/`, `media/` |
| Script and voice | `write_script` from a brief (copied runs refused), narration through OpenRouter speech, word timings | `src/engine/jobs/handlers/write-script.ts`, `voice.ts` |
| Planning and model choice | Five-step visual decision, director check, the orchestrator's model choice from the live catalog (Bible 10.5) | `src/engine/plan/`, `claude/roles/` |
| Budget | Reserve, extend, reconcile, release; cap mode; holds for unbilled calls; reconciler job | `src/engine/budget/`, `engine.reconcile_holds` |
| Production | Asset router with cache, circuit breaker and provider adapters (OpenRouter video, image and speech; Pexels; Pixabay) | `src/engine/assets/` |
| Edit | Deterministic EDL from the plan, takes and word timings | `src/engine/edit/` |
| Compose and render | Compiler to HyperFrames HTML; HyperFrames cloud render; Shotstack fallback code; integrity checks | `src/engine/compose/`, `render/` |
| Review | Take gate (code checks, similarity, rubric), pre-render gate, post-render review, Critic | `src/engine/review/` |
| Delivery | Manifest per video, ledger settlement, one master per request | `src/engine/jobs/handlers/deliver.ts`, `deliver/` |
| Factory integration | A Factory creative can be made by the engine and linked to its request | `src/lib/meridian/factory/produce-engine.ts` |
| Content Factory page | Sessions, files and sources, brief, start, revision (a new request), the run view as step cards | `src/lib/meridian/content-factory/`, `src/components/content-factory/` |
| Flow board (new) | The run as a vertical flow of steps; the shots as nodes; a moving line into the step that is running; a shot panel | `src/components/content-factory/run-board.tsx`, `status.ts` |
| Hot swap (new) | Remake one accepted shot of a delivered video (section 3) | see section 3 |

## 3. The hot swap: remaking one shot of a delivered video

A reviewer watches a delivered video, sees one shot that is wrong, and asks for that shot to be made again. The rest is kept.

**What a reviewer does.** Opens the run, clicks the shot, optionally writes a direction (at most 280 characters), and presses "Remake
this shot". The board shows the revision, the shot's new status, and any earlier directions.

**What the engine does** (Bible 5.5 has the rules):

1. The remake checks that the video is delivered, has no variants, and the shot is an accepted generated or stock shot. A refused remake
   returns its reason; nothing is reserved.
2. It reserves the shot's own estimate: one shot line, the fixed per-master lines, and a redo allowance. Chosen models are priced at their
   catalog price. If the reservation is refused, nothing else happens. If the event is refused after the reservation, the reservation is
   released.
3. The orchestrator's `remake` event starts a new epoch for the shot, so its old takes stop counting and its redo budget starts again. It
   queues one produce job with a new attempt (a new seed and cache key), carrying the direction. The direction joins the prompt after the
   rules, in a labelled block.
4. The new take is checked. It is redone twice if it fails, and then it goes to a person. It is never downgraded, because a downgrade would
   replan the whole plan.
5. When the shot is accepted, the edit is cut again on the new take. Compose, the pre-render gate, render, post-render review and deliver
   run on the new master. Delivery names the current master, so the superseded one is never delivered.

**Tests that prove it on fixtures.** `src/engine/jobs/remake.test.ts` (14 cases on the state machine). `src/engine/ops/remake.test.ts`
drives the real chain on PGlite: a delivered video's shot is remade, checked, cut, rendered and delivered as a second master, and the feed
shows the revision. `src/engine/deliver/videos.test.ts` covers the master being named. `src/engine/api/index.test.ts` covers a refused
remake holding no money. `src/lib/meridian/content-factory/` covers the service's admin check, the input limits, and the board mapping.

**What it does not do yet.**

- It re-renders the whole video. A splice render (re-render only the changed window and join it) would need the captions to be a separate
  layer first.
- It works only after delivery. Remaking a shot while the video is still being made would need in-flight jobs cancelled first.
- It refuses videos with variants, because their variants would be stale. Rebuilding variants after a remake is not built.
- It keeps a reviewer's directions for one shot (at most eight). A direction for the whole video is not built.
- It keeps the chosen model. A reviewer cannot pick another model for the remake yet.
- If the process dies between the reservation and the event, the reservation stays held. Nothing sweeps it yet.

## 4. What is left, against the vision

The vision: a person directs a video the way a creative director would, sees each step as it runs, and can change one piece without
starting over. The board, the moving steps and the shot remake are the first version of that. In rough order of value:

1. **See the shots.** The board shows no picture of a take yet. The media link (`engine/jobs/media-link.ts`, a 15-minute signed link)
   already exists. Wiring it to each take lets a reviewer watch the shot before deciding.
2. **Wire the review inbox's extra actions.** `change_visual_type` and `edit_prompt` are defined in `engine/review/inbox.ts` and labelled in
   `review/labels.ts`, but no screen or event applies them. The hot swap is the path they should use.
3. **Swap in the reviewer's own clip.** An asset shot already exists in the contracts. A remake could take an uploaded clip for one shot
   instead of a generated one.
4. **Choose the model for a remake.** The orchestrator already chooses models (Bible 10.5). A reviewer should be able to ask for a different
   one for one shot, and the cost should show before it is reserved.
5. **Remake mid-run.** Pause a shot that is being made, change its direction, and continue.
6. **A direction for the whole video.** "Make the hook punchier" needs a re-plan of the affected shots and beats, not only one take.
7. **Splice render.** Render only the changed window and join it into the delivered video. This needs the caption layer separated, and it
   would cut the cost and time of every remake.
8. **Variants after a remake.** Rebuild the variants of a revised master.
9. **Cost on the panel.** Show the reserved cost of a remake before the reviewer confirms it.

## 5. Live gaps and owner decisions

Nothing has run against a live provider. Every live step needs the owner's keys and one recorded run (`docs/engine/PHASE_LOG.md`, the
2026-10-17 entry, has the list).

- **Render.** The HyperFrames price per minute is unset, so the render stays not connected. A remake of a video therefore cannot produce a
  new MP4 in production until that price is set (ROADMAP, owner items). The Shotstack fallback is unconnected too.
- **Narration, speech-to-text, the video catalog and the media functions host** are unverified live (`docs/LAUNCHPAD.md`, "Not verified
  live").
- **Owner decisions still open** (`docs/LAUNCHPAD.md`, "Owner decisions still open"): the render fallback, narration defaults, video-DNA
  frame labelling, alerting on held calls, six-decimal bills, lip-sync and avatar vendors, text files and Drive, three prices the engine will
  not guess, and the Deepgram project id.

## 6. Bugs found while doing this

- **The delivered master could not be read at HEAD.** `engineDeliveredMaster` (`src/engine/api/index.ts`) read the manifest by the state's
  `manifestId`, which deliver sets to the video id. The manifest is stored under the slot `manifest:<videoId>`. The Factory's engine path
  (`src/lib/meridian/factory/produce-engine.ts`) calls this reader, so a delivered engine video could not be linked to a creative. It is fixed
  here. The test helper that stood in for a delivery had written the state the old way, and it now writes the state the way deliver does.
- **A stale refusal.** The message for a session that has already made its video said revisions are not built. Revisions exist (migration
  `0106`). The message is corrected.
- **`npm run typecheck` fails in this environment before it reaches any code.** The locked TypeScript (5.9.3) rejects the `baseUrl` option in
  `tsconfig.json` (TS5101). With the deprecation silenced (`--ignoreDeprecations 5.0`) the project typechecks clean. The config is not changed
  here; the owner should decide whether to change `tsconfig.json`.
- **An earlier note is wrong.** The 2026-10-17 checkpoint says PDF text is not read. The code reads it (`content-factory/service.ts`), and the
  launchpad is right.

## 7. Update 2026-10-22: the take on the board and the remake's cost before it is confirmed

Section 4, items 1 and 9, are done on fixtures. Nothing here calls a live provider.

- **See the shots (item 1).** Selecting a shot with a take shows that take in the shot panel. The engine (`shotTakeLink`, `src/engine/api/index.ts`)
  takes the shot's accepted take, or else its newest take of the current plan epoch, and gives the media signer the take's own stored `uri`. The
  link is 15 minutes (`ENGINE_MEDIA_LINK_TTL_SECONDS`) and the board reads it again after 10. Each state is shown in words: no take yet, the take
  not stored yet, the media signer not connected (no `MEDIA_LINK_SECRET` or public origin), or a take whose record does not match its contract,
  which is refused and never linked. Nothing is logged or stored.
- **The cost before confirm (item 9).** The panel quotes the remake before the reviewer presses the button (`quoteEngineShotRemake`). It runs the
  same checks as the remake (the shot, the month's budget, the chosen models' prices, the request budget and the workspace month, as `reserve()`
  makes them) and writes nothing. The quote says what is held (an estimate at list prices, released when unspent) or why the remake would be
  refused, and the button stays off for a refused or unfitting quote and while the quote loads. A quote that cannot be read leaves the button
  on: the engine checks again when the reviewer confirms.
- **Refactor.** `remakeEngineShot` now takes its checks from `remakeContextOf`, shared with the quote. The directive is checked first; the
  reserve-and-apply path and its refusals are unchanged. `src/engine/ops/remake.test.ts` passes unchanged.
- **Tests.** `src/engine/api/shot-take.test.ts` (which take a shot shows), `src/engine/ops/shot-preview.test.ts` (the signer is given the take's stored
  uri; a missing signer is reported; a shot with no take is not signed; a quote changes no revision and is the same twice; an unknown shot is refused),
  `src/components/content-factory/shot-presentation.test.ts` (the quote's words and the button rule), and a service test for the gate (a member is
  refused, a session with no video has no take, nothing is signed, the quote is refused). 82 tests across the Content Factory folder, the engine
  API and the remake tests pass. Lint is clean on the changed files. Typecheck was not run, as instructed.
- **Still open on the page (section 4, items 2 to 8).** 2, the review inbox's `change_visual_type` and `edit_prompt` have no event or screen (the
  direction field is the same path as `edit_prompt`, but the inbox does not reach it). 3, a reviewer's own clip for one shot. 4, a different model
  for one shot's remake: the plan's chosen model is read in `chosenPricesFor`, and changing it needs the model-choice artifact and the produce
  stage to take the new choice. 5, remake mid-run. 6, a direction for the whole video. 7, splice render (blocked on the caption layer). 8, variants
  after a remake. The page has not been looked at in a browser: no screenshot was taken.

## 8. Update 2026-10-22, autonomous run: section 4, items 2 to 8

Every item below is built and tested on fixtures. Nothing calls a live provider, and no browser check of the page was made.

- **2. Review inbox actions.** `edit_prompt` edits a generated shot's prompt (D8). `change_visual_type` changes a shot to cinematic (from a
  prompt) or to stock footage (from a query). Any other type is refused. Both are replacements of the shot's spec (D7) and run as a remake.
  The decision contract is `src/engine/review/shot-decision.ts`.
- **3. The reviewer's own clip.** A clip is probed (an H.264 MP4 at the take size, long enough to cover the shot), stored as the shot's take, and
  accepted with the reviewer's acceptance as its verdict. No model is called for it. The editor reads an asset shot's take like any other take. The
  clip is licensed by the reviewer's attestation (`src/engine/jobs/reviewer-clips.ts`). Production's licence port is not wired anywhere yet, so the
  pre-render gate still cannot evaluate rights for any video. That is the open gap, not the clip.
- **4. A model for one shot.** The reviewer picks a model from the live catalog. Only models eligible for the shot's need are offered, priced the way
  the orchestrator's choices are, checked again when the remake is made, and carried to the take's produce job (D11, source `reviewer`).
- **5. A shot changed while the video is made (D10).** A shot still being made can be changed in place: its direction and its model. Its epoch moves,
  so the take in flight is stored as stale and never counted. The video's revision does not move, and the change draws on the video's own reservation:
  the new call is authorized against it when it is made. A change that does not fit pauses the video for budget. Source changes and accepted shots
  wait for delivery.
- **6. A direction for the whole video (D9).** A revision can carry a direction. It is posted as the session's next instruction after the revision
  reopens the session, so the new brief carries it, and the whole video is planned again. An empty direction revises as it always did.
- **7. Splice render: planner only.** `src/engine/render/splice.ts` plans the window a change re-renders (widened to the nearest beats) and the parts to
  keep. Execution is not built, and cannot be built yet: the repository has no window render (HyperFrames is rendered whole) and no trim or join in the
  media functions (they probe, sample and measure only). Until both exist and are verified live, a remake renders the whole video. This is the owner's
  decision to make, with the render and media work.
- **8. Variants after a remake.** A delivered video with variants can be remade. Its variant branches are superseded, and the variant stage runs again
  on the new master, which delivery waits for. A video is delivered only after its variants settle, so no variant job is in flight at a remake.

Still open, from this list and the record: the production licence port (rights for every video, including a reviewer's clip); the splice execution
(item 7 above); the orchestrator's handlers for visual, voice, video, avatar, edit, compose and render; and the open review items in
`docs/engine/REVIEW_2026-10-22.md`.
