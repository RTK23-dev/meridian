# Decisions made on the owner's behalf, 2026-10-22

Made under the standing instruction to finish the phases and decide where the owner's call is not needed for the code to move. Each one
is recorded so the owner can overturn it. None is verified by a live run. A decision that needs a live run is marked so.

## D1. Deepgram `nova-3` stays the pre-recorded speech-to-text model

- The Bible names `nova-3` for pre-recorded transcription, and the repo's `stt` route uses it (`src/engine/config/routes.ts`).
- Nothing in the repo records `nova-3` as retired. The request lookup (`/v1/projects/{project}/requests/{id}`) returns the model used, so the first live call confirms it.
- Reversal: change the id in the `stt` route. The media code reads the route, not a literal.
- Not verified live. Needs the owner's Deepgram key.

## D2. The three Claude role models stay pinned for the legacy pipeline

- `llm.direction`, `llm.analysis` and `llm.check` keep their fixed ids. They are the production path for the legacy roles, and their prices and
  output shape are what the ledger and the contract tests were written against.
- The orchestrator does not use them. Its text steps (analysis, script) call the model the user chose from the live catalog.
- Changing a pinned role model changes cost and output, so it waits for a live run that prices the new model. Not changed here.

## D3. A paid step whose call was already made is refused, not retried

- A step's call is keyed by its plan and cache key. A second attempt with the same key is refused before any call, so a call is never paid twice.
- Consequence: when a call fails after it was authorized (its hold stays on the ledger with no bill), that step stays blocked until the step
  is edited, which gives it a new key. The reconciler settles the hold once a provider reference exists.
- This trades a stuck step for no double billing. It matches the open high item in `REVIEW_2026-10-22.md` (a timed-out Claude call paid again on
  retry). The owner can choose a retry policy later; the code keeps the fail-closed default.

## D4. A run takes one reservation for what the plan may still spend

- Opened before any step runs, sized to the plan budget less what earlier runs spent (stored outputs plus failed-step holds). Released when the
  run stops, so the workspace month gets back what was not spent. A run that does not fit the month is not started.
- Failed-step holds are counted in the plan's spend (recorded on the failed event), so money held by a failed call is never dropped.

## D5. Steps still not connected

- `visual`, `voice`, `video`, `avatar` (adapters not yet wired to a plan step: image and speech bytes need the asset store, and video is a queued
  job, not an inline call) and `edit`, `compose`, `render` (the engine's edit and render pipeline is not wired to a plan) have no handler. The
  executor reports them `not_connected`. This is stated, not hidden.

## D6. A refusal before any call holds nothing

- A refused budget, a call already authorized earlier (a duplicate), a missing model or upstream body, and an unusable model id stop the step with `CallRefusedError`. The step fails and no estimate is held, because no money was committed.
- Only a failure after authorization (the call was made, or may have been) holds the estimate, so the spend never counts money a refusal never committed.
