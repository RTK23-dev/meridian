# src/engine/api: the engine's API for Meridian (lead tasks I1 to I3)

**Brief requests (contract v8, this branch).** `startEngineRequest` passes `brief: request.brief !== undefined` to the orchestrator's start,
so a brief's write_script runs and a script request skips it (`../jobs/STATUS.md`).

## Built

- `index.ts` is the only surface the Factory and the Reviews inbox use for the engine:
  - `startEngineRequest`: validates a ProductionRequest with the engine's schema, stores its production_request artifact and queues
    intake in one transaction. A `beforeQueue` hook lets the Factory write its link to the request in the same transaction.
  - `engineRequestStatus`: queued, running, paused (with the engine's reason), needs_review, delivered (with the manifest id), or failed.
  - `engineDeliveredMaster`: the manifest and the rendered video of a delivered request, read through their contracts.
  - `engineSpendOf`, `pauseEngineSpend`, `reservationState`: the actual cost on the request's ledger (pending calls counted, not zeroed),
    and the pause of a request's live reservations with a reason.
  - `openEngineReviewItems`: the open review items of a brand, read only.
  - `engineReadiness`: NOT_CONNECTED with every reason (no monthly budget, no OpenRouter key, no render key, a stage with no handler).
- Migration `migrations/0082_factory_engine_requests.sql` links each Factory video to its engine request, its run and its variant.
- `index.test.ts` covers the above on the engine test database, with no provider call. It was written but not run: the owner asked the
  lead to run every check after all phases.

## Owner items (not agent work)

- Live run: none by agents. Production readiness stays NOT_CONNECTED until analyze_reference, voice, produce_shot, check_take, render and
  post_render_review have production handlers, and the OpenRouter and render keys are saved in Settings.
- A Factory plan carries none of the engine's required fields: format id, reference video, script beats, page and style kit, voice. A
  run that names the engine stops and lists them. Where they come from is an open decision (Bible 20.2).
- Engine review decisions are not reachable from Meridian yet. The Reviews inbox shows the engine's open items read only.
- Engine masters are not approved by any path yet: approval in Meridian's reviews needs a jev decision row, so a master stays in review.
