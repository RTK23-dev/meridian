# Asset router and adapters (W5): E3 asynchronous submit and settle

## Speech through chat completions, provider refs and the voice's provider (contract v9, owner decision 2026-10-17)

- `providers/openrouterSpeech.ts` now sends `POST /chat/completions` with `modalities: ["text", "audio"]`, `audio: {voice, format: "mp3"}`
  and `stream: true` (OpenRouter's audio output). `speechFromStream` reads the server-sent events: each `delta.audio.data` is decoded on its
  own and the bytes are joined in order (a base64 chunk is not joined as text), the first event's `id` is the generation id, and `[DONE]` is
  required. An error event, a non-base64 chunk, no audio, or a stream that ends before `[DONE]` is refused, never completed.
- The bill is read once after the audio is stored, through `gateway/generation.ts` (`openRouterGenerationBill`). Every miss is unavailable,
  and the submit stays unsettled (contract v6). The generation id is recorded on the entry (below), so the reconciler can read the bill later.
- `voiceProvider` (new on `ProduceInput` and `AdapterContext`, from the voice kit's `provider`): a speech model is connected for a page only
  when its vendor (the model id's part before the slash) is the page's voice provider. Otherwise the router never sends the voice id.
- `router.ts` records the adapter's generation id (`detailsFor(...).generationId`) as the ledger entry's `providerRef` in `settleClaimed`,
  whether or not the bill arrived. An unsettled speech submit keeps its generation id, so `reconcileHolds` can settle it (contract v9).
- `routes.ts` `tts`: `elevenlabs/eleven-v4` (price key `eleven_v4`, $40 per million characters) and `google/gemini-3.8-flash-tts` (price key
  `gemini_3_8_flash_tts`, $9 per million output tokens). The Gemini target is not estimated: its price is per output token, so `price()`
  refuses it with unknown_price, and the router excludes it. Both ids are unverified.
- Tests: `providers/openrouterSpeech.test.ts` (the stream join and its refusals, the request, the voice's provider, the bill, the speed);
  `router.test.ts` ("speech voices": the cache key, a billed take, an unsettled take with its generation id, a wrong vendor).
- UNVERIFIED LIVE: the request shape, the speech text as the user's message, the top-level `speed` (not documented for audio output), the
  stream's id as the generation id, and the stats' `total_cost`. The owner's live run records one take with its stream, id and bill.

## Speech bill from the generation stats (round 2, lead decision 2026-10-17; branch worktree-agent-a16624873a0973b89; superseded in its request shape by the v9 section above)

- `providers/openrouterSpeech.ts`: the speech call is still `POST /audio/speech` (the repo's PROVIDER_APIS.md and the adapter's recorded
  shape). Its answer header carries the generation id. The bill is read ONCE, after the answer is stored, with `readGenerationBill`:
  `GET https://openrouter.ai/api/v1/generation?id=<generation id>` through the gateway, `data.total_cost` in USD.
- A miss (a failed read, no generation id, no `total_cost`, or stats not yet there) leaves the submit unsettled (contract v6). No list price
  is booked as the cost. The poll answers `done` with `actualUsd` only when the bill was read; the router settles from it.
- A memory of the read per job (`bills`) means a second poll does not read the stats again. The read is not retried in the adapter.
- Fixtures: `test/fixtures/openrouter-generation-stats.json` (a total_cost) and `openrouter-generation-stats-no-cost.json` (none). Synthetic
  in the documented shape. UNVERIFIED LIVE: the endpoint, its field, and how long the stats take to appear after the answer. The lead's
  premise (chat completions with `stream: true`) is not what the adapter sends; the owner's live run decides.
- MP3: the speech output is stored as `mp3` (lib/meridian/storage/engine-asset-media.ts), so the link route and the engine's media store
  accept it. See `../../lib/meridian/storage/STATUS.md`.

## Orchestrator model choice in the router (Bible 10.5, contract v7; 2026-10-17)

- `router.ts`: `RouterDeps.catalog?: ModelCatalogSource`. When `spec.modelChoice` is set, the router reads the (cached) catalog, checks
  the chosen model is still listed for the spec's class and still fits the spec (`needOf` + `rejectionOf`), and makes it the only target:
  route `openrouter:<modelId>`, the adapter of its class, the video profile from the same catalog read, and the estimate from the catalog
  price (`catalogEstimateUsd`, rounded up to 4 decimals). The adapter id is `openrouter:<modelId>`, so `assetCacheKey` and the ledger key
  distinguish models. A decision records the choice and its price. If the model left the catalog, no longer fits, the catalog cannot be
  read, or the runtime has none, a decision says why and the route table's targets are used (the fallback). Settlement is unchanged
  (OpenRouter's `usage.cost`). `modelChoice: null` takes exactly the old path and reads no catalog.
- `model-choice.ts`: `needOf(spec)`, `catalogEstimateUsd(entry, spec)`, `fallbackModelsFor(gateway, class)` and
  `resolveModelChoice({ modelClass, eligible, pick, failure, fallbackModels, catalogReadAt, at }) => { modelChoice, decision }`: a pick is
  accepted only if it is one of the call's eligible ids; otherwise (or with no pick) the first route-table model that is eligible, source
  `fallback`; with none, `modelChoice: null` and the route table applies. The director's reason is kept as one-line data, max 500 chars.
- Tests: `model-choice.test.ts` (9), `router-model-choice.test.ts` (7). All recorded; no live call.
- The pick comes from the `model_chooser` call after the plan (`plan/model-choices.ts`, contract v8). `needFor(call)` builds the need
  from a planned call before its spec exists. The router's choice decision now carries the choice's own reason.

## Video profiles for production (this pass): `video-profiles.ts`

- `videoProfileLoader({ gateway })` is the production loader the shot ports use (`jobs/runtime.ts`, `ShotPorts.videoProfiles`). It reads
  GET /videos/models through the gateway (`listVideoModels`), for one workspace's credential, and maps each routed OpenRouter model of
  `video.cinematic`, `video.budget` and `video.i2v_pinned` to its `VideoProfile` (`videoProfilesFromListing`). The models come from the route
  table: the `video.cinematic` and `video.budget` models today; `video.i2v_pinned` has none.
- A successful read is kept per workspace for the loader's life (one loader per runtime). A failed read is not kept, so the next call reads
  again. Concurrent calls for one workspace share one read.
- Every routed model the loader leaves out has a reason, from `gapsFor(organizationId)`: a listing that could not be read (HTTP status or error
  class; a missing key is `NOT_CONNECTED:`), a listing with no data array, a model the listing does not name, or an entry that does not parse.
  The reasons are the engine's own text; the provider's words appear only as the classified excerpt.
- `noEligibleVideoModel` is the eligibility rule for a video class: at least one routed OpenRouter model with a profile is eligible. Otherwise
  it returns each model's reason, and the shot is refused with them before any paid call. A non-video class is never refused here.
- Interface change, for the lead: `ShotPorts.videoProfiles` is a loader object, not a Map, and `loadVideoProfiles` takes the workspace id (the
  key is the workspace's). Callers in `jobs/runtime.ts` updated; no other caller passed a profile map to ShotPorts.
- Tests: `video-profiles.test.ts` (recorded listing, failed listing, missing key, no data array, a rejected entry, the eligibility rule).

## Cartoon chain: image references, first frame, and a stateless image result (branch `worktree-agent-adcc78d81ea833bab`)

`providers/openrouterImage.ts` (the image adapter, for image.keyframe and image.edit):

- **References and first frame.** A spec's first frame (when it has one) and its references are sent as `input_references`, in that order,
  each as `{ type: "image_url", image_url: { url } }`. The element shape is the documented shape of a `frame_images` element; PROVIDER_APIS.md
  names `input_references` and does not describe an element. Unverified until the live run.
- **Limits.** Every reference must be an https URL the provider can fetch (`normaliseHttpsUrl`). A store uri is refused before any call
  (`invalid_input`, no call made). A last frame is refused the same way. More than `IMAGE_REFERENCES_MAX` (4, an initial bound; the
  provider documents none) is refused before any call. The router sees `firstFrame: true` and `refsMax: 4` on the image capabilities.
- **Stateless results.** The answer of an image call (the uri, the media type, the bill, or the failure message) travels in the job
  reference (`encodeImageResult` / `decodeImageResult`, base64url, under the `image:` prefix). Before, it was kept in process memory, so a poll
  by another worker's adapter instance found "no result" for a paid image. Now any instance reads it. A reference this adapter did not write
  is a failed poll with no details.
- Tests (`openrouterImage.test.ts`, 13 pass): references sent in order from a recorded answer (`test/fixtures/openrouter-image-references.json`;
  its image is a valid PNG padded above the adapter's 1 KiB floor); no `input_references` when there are none; a store uri refused with no
  call; a last frame and too many references refused with no call; the capabilities; a second instance reads the same result; a foreign
  reference fails closed. The whole folder (`src/engine/assets/**`) runs 151 tests, 0 fail, before the plan and edit changes.

Not changed: the video adapter. Its frames still need https (`normaliseHttpsUrl`), and its profile has no reference support (`refsMax` 0).
The cartoon clip therefore carries no references (plan/STATUS.md).

**Open for the owner's live run**

1. The `input_references` element shape and the reference limit (see above). The live answer is recorded in `test/fixtures/` when run.
2. Whether the provider fetches a link produced by Meridian's signed engine-media route (the first frame and the references need it).

Branch `eng-e3-router-async`, cut from `origin/code/beautiful-cori-1zfk11` at `c0767f2`. Fixture-tested only. No live call has
been made: agents hold no keys (North Star decision 1). The owner's live run is listed at the end of this section.

## What changed (E3)

The router was synchronous: `produce` submitted and polled inside one paid call, so a generated take blocked a worker for the
length of the render. It is now three entry points over one state machine (Bible 15.2):

- **`submit(input)`** chooses the target (scored, cached, connected, breaker-checked), authorizes the submit on the ledger, sends
  it, and returns `{ step: { status: "submitted", job, runAfterMs: 0 }, decisions, alerts, attempts }`. A cache hit or a refusal
  returns the terminal `ProduceOutcome` instead. The job holds one concurrency slot on its target until it is settled.
- **`settle(job, poll, input)`** takes the poller's finished answer (`done` or `failed`; a `pending` answer is refused). It
  downloads and checks the take when `takes` is set, reconciles the submit's ledger entry to its bill (or its list estimate when
  the provider reported none), records the attempt in stats and the breaker, and returns one of: `done` (the asset, cost summed
  over the winning target's submits), `failed` (content_policy or invalid_input, to the planner), `submitted` (a retry on the same
  target, with `runAfterMs` = the backoff, or the next target), or the terminal `unavailable`, `refused`, `queued` or `duplicate`.
- **`produce(input)`** is `submit`, then poll each job with the backoff and the deadline, then `settle`, until the step is terminal.
  Synchronous callers and the existing tests use it. Its behaviour is unchanged except where the ledger notes below say so.
- **Idempotent settle (Bible 5.1).** Each settled submit is recorded under `workspaceId + idempotencyKey` in a `SettlementStore`
  (`job.ts`). A second settle returns the first result with no provider call, no ledger write, no stats record and no cache write.
  A settle that is running in another call is refused as retryable (`conflict`), so two polls of one job cannot both retry the
  same submit. A claim whose lease (`thresholds.jobs.leaseMs.generation`) has expired is taken over.
- **The job reference** (`job.ts`, `meridian.asset_job/v1`) is plain JSON, validated with zod on every parse: the provider's job
  id, the submit's ledger key (also the idempotency key sent with it), the scored targets with their cache keys and estimates,
  the target index, the attempt on the target, the submit number across the asset, the bills reconciled so far, and a carry of
  the reasons the targets so far failed, were refused, or were queued. A job that names another request, workspace or reservation,
  or a spec other than the one it was submitted with, is refused before any side effect.

### Ledger (one entry per submit)

Each submit is its own ledger entry (Bible 14.1). The first submit of a target is keyed by its cache key, as before. A retry on
the same target is keyed `<cacheKey>|attempt<n>`, so it is authorized before it is sent and holds its own estimate. The asset's
cost is the sum over the winning target's submits, as before. In `router.test.ts` the assertion for Kling changed: the three
refused submits are three entries that sum to 1.89 (the first alone is 0.63). The total is the same; the books now show each
submit.

### Retries and the slot

| Event | Next step | Slot |
| --- | --- | --- |
| Submit-time rate_limit or server (or retryable unknown) | Retry inside `submit`, with the backoff slept (1 s, 2 s, ... capped), up to `thresholds.jobs.maxAttempts` submits | held |
| Settle: failed with a retryable error, attempts left | New submit on the same target, returned as `submitted` with `runAfterMs` = backoff | held, passed to the new job |
| Settle: timeout, or non-retryable unknown, or retries used up | Next target (a `Decision` names the failed target), or `unavailable` | released before the next target |
| Settle: content_policy or invalid_input | `failed` for the planner, no fallback | released |

A poll deadline is a timeout. Cancel is best effort and is the caller's job before settle (see the open items).

### Takes (opt-in)

`createAssetRouter({ takes: {} })` makes settle download the finished video through the gateway (`gatewayDownloader`, 150 MiB
limit), check it is an mp4 (`normaliseVideo`: an `ftyp` box at byte 4, between 4 KiB and the media functions' input limit), and
store the bytes through the `MediaStore`. The asset then names the stored copy. A download that fails with a retryable error throws,
so the poll job retries the settle with nothing recorded. A file that fails the checks is a failed take and the next target runs.
Without `takes` (the default, and what `produce-shot` uses today) settle returns the provider's own https uri, and the take stage
downloads it as before. Only one of the two should download: see the produce-shot change below.

## Test results (real output, this branch)

- `NODE_ENV=development node --experimental-strip-types --test src/engine/assets/*.test.ts src/engine/assets/providers/*.test.ts src/engine/jobs/handlers/produce-shot.test.ts src/engine/jobs/e3-pipeline.test.ts`
  gives `# tests 163`, `# suites 45`, `# pass 163`, `# fail 0`, `# skipped 0`. The 125 before this change plus 38 new.
- New tests: `submit-settle.test.ts` (15: submit then settle done, with the slot and the ledger; settle failed then next target;
  rate-limited retry on the same target with the summed cost; settle twice; two settles at once; timeout moves to the next target
  with no retry; planner refusal; pending refused; another workspace refused; another spec refused; takes stored; takes download
  503 retried with nothing recorded; a non-mp4 take moves on; a submit answer with no job id is a failed submit and frees its slot), `job.test.ts` (schema and settlement store, 14), `ledger-steps.test.ts`
  (lock use, 3), `normalise-take.test.ts` (video and uri checks, 6).
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing UI files under `src/components/` (none in this change). ESLint on
  `src/engine/assets` and `src/engine/jobs` alone: exit 0, no output.

## Changes needed outside this folder (reported, not made: src/engine/jobs is not this workstream)

These are for the handler owner. `produce-shot.ts` currently calls `router.produce` and treats `submitted` as an error.

1. **Submit.** `routerGenerator` calls `router.submit(input)` instead of `produce`, and returns `submitted` with the whole
   `AssetJob` and `runAfterMs`. `run()` must accept `submitted` from the generator (it throws for it today, in `fromProduction`).
   The job goes in the poll payload (a new `job` field next to `provider`, `jobRef` and `submittedAt`); `scheduleProviderPoll`
   takes the job's first-poll delay from `runAfterMs`, not from `jobSettings.poll.initialMs`.
2. **Settle.** `ShotGenerator.settle` takes the `AssetJob` (not `{providerId, jobRef, submittedAt}`) and calls
   `router.settle(job, polled, input)`. Its `StepReport.step` maps like `ProduceOutcome`, except:
   - `submitted`: `finish` must schedule the next poll for the new `job` (through `scheduleProviderPoll`) and return without
     `applyEngineEvent(succeeded)`. Today `finishPoll` always stores the output as the stage's result.
   - Routers are built with a durable `settlements` store (Postgres). The memory store is not shared across workers, so a
     settle run on another worker would repeat a retry submit. This is the blocking item for production.
3. **Timeout.** The poller's `timed_out` branch throws today. It should call `adapter.cancel` (as it does) and then settle the job
   with `{ state: "failed", error: { kind: "timeout", retryable: true, message } }`, so the next target runs (Bible 10.4).
4. **Download, one place.** Either `produce-shot` keeps `storeTake`'s download and the router is built without `takes` (today's
   behaviour), or the router is built with `takes` and `storeTake` uses the stored uri and skips its own download. Doing both
   downloads twice. The lead to choose.
5. **Bucket leases.** A slot is held from submit until settle. A poll job that dies without settling keeps its slot. The Postgres
   bucket store needs a lease, so a slot expires with its job's lease.

## Open items and risks (owner or lead to decide)

- **Image results are in process.** `openRouterImageAdapter` keeps its job's result in memory, so its poll must run in the process
  that submitted it. `produce` does. A poller on another worker gets "no result" (a failure that is not retryable, so the next
  target runs). Image jobs need durable results, or their submit and poll must stay in one job. Video jobs poll the provider and
  are unaffected.
- **Cancel.** Settle does not cancel. `awaitTerminal` cancels on its own deadline; the poller must do the same before it settles a
  timeout (change 3).
- **Crash between submit and record.** A worker that crashes after the provider accepts a submit and before the job is recorded
  leaves an unknown provider job. OpenRouter documents no idempotency header, so a retry can bill twice. The ledger holds one
  estimate per submit, so the books show the risk. This is the open risk the jobs STATUS already names. A crash between a side
  effect and `settlements.complete` runs that settle again: the reconcile is idempotent, but a stats record can repeat.
- **Retry of a submit that was authorized but never sent.** If a crash falls between `authorizeSubmit` and the provider call, the
  next run finds the key authorized and returns `duplicate`. The job then fails closed (conflict) and nothing is sent twice.
- **Memory stores.** `memorySettlementStore`, `memoryBucketStore`, `memoryProviderStats`, `memoryBreakerStore` and
  `memoryAssetCache` are for tests and single-process use. None of them is shared across workers.

## Owner's live run (E3, in addition to the E2 steps below)

1. Build the router with the Postgres stores and `takes: {}` (or without `takes`, per change 4).
2. `submit` one `video.cinematic` spec (5 s, 9:16). Record `job.providerId`, `job.jobRef`, `job.idempotencyKey`, the ledger
   estimate, and the activity-page cost before any poll.
3. Poll the job once with the adapter's `poll`, then `settle`. Record `asset.costUsd`, `costIsEstimate`, `ledgerEntryId`, and the
   ledger's actual. Settle the same job a second time and confirm no request is sent (count the provider's GET and POST calls).
4. Force a rate limit on the same spec if the provider allows it, or a timeout with a short `pollTimeoutMs`, and record that the
   next step is the same target (rate limit) or the next target (timeout), with each submit's own ledger entry.

## E2 status (retained below)

The text that follows is the E2 status. It is unchanged except where the E3 section above says otherwise (notably the
ledger count for Kling's refused submits, which is now one entry per submit).

## Done (fixture-tested)

- `router.ts`: `createAssetRouter(deps).produce(input)`. Targets from `gateway.routes(modelClass)`. Filters: connection,
  capabilities (duration, aspect, frames, references), a known price, a closed breaker. Scores with the 10.2 weights. Cache
  hit at $0 (per workspace). Otherwise each candidate runs under one `paidCall` keyed by `assetCacheKey(spec, adapter.id)`,
  with its concurrency bucket held for the whole call. Retries and fallback follow 10.4 (see the table below).
- `score.ts`, `breaker.ts`, `buckets.ts`, `cache.ts`, `stats.ts`: pure logic and store interfaces, with in-memory implementations.
- `normalise.ts`: image (PNG, JPEG, WEBP only; type and magic bytes must match; SVG refused), speech (MP3 magic), https URLs,
  strict base64. `classify.ts`: HTTP status, thrown error and failed job to `ProviderError`.
- Adapters (`providers/`): OpenRouter video (one per model, profiles from `GET /videos/models`, 9:16, 1080p, voice off,
  first and last frame), OpenRouter image (`POST /images`), OpenRouter speech (`POST /audio/speech`), HeyGen Avatar IV
  (NOT_CONNECTED, sends nothing), Pexels and Pixabay (stock search with attribution, in `stock.ts`).
- `firstLastFrame.ts`: the 20.3 item 2 harness. Pure table from a listing; live run that submits one test per model whose
  listing shows both frames, under the reservation. Output: rows, a markdown table, and `pinned` for `video.i2v_pinned`.

## Retry and failure rules (as tested)

| Error | Retry on the same provider | Then |
| --- | --- | --- |
| rate_limit, server (and unknown retryable) | yes, backoff 1 s, 2 s, ... up to 3 submits | next target |
| timeout (poll deadline) | no | next target (no cancel: OpenRouter documents none) |
| content_policy, invalid_input | no | `failed` returned to the planner, no fallback |
| unknown (not retryable), including credential refusals | no | next target |

## Test results (real output, head of this branch)

- `NODE_ENV=development node --experimental-strip-types --test src/engine/assets/*.test.ts src/engine/assets/providers/*.test.ts`
  gives `# tests 103`, `# suites 32`, `# pass 103`, `# fail 0`, `# skipped 0`.
- `NODE_ENV=development node --experimental-strip-types --test src/engine/gateway/boundaries.test.ts`: `# pass 3`, `# fail 0`.
  The boundary rules hold: no `fetch`, no credential reads, no model platform host outside `providers.ts`.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors, 4 warnings, all in existing UI files (`src/components/...`), none in this change.

## Decisions for the lead to review

1. **Unknown scores.** A dimension with no value (no pass rate, no gold-set score, no latency comparison, no price difference,
   no continuity provider) is left out of the weighted mean. It is neither 0 nor 1. Ties go to more known weight, then to the
   route's priority. Every decision names the unknown dimensions. In E2 the known dimensions are control (from capabilities),
   cost (when the eligible prices differ) and continuity (when there is an earlier shot). Reliability and latency become
   known after 7 days of attempts.
2. **Retries inside one paid call.** A retry under the same key would be refused as a duplicate, so the whole retry loop for a
   candidate runs inside one `paidCall`. The key is the cache key, which includes the provider, so each provider has its own.
3. **The ledger actual is conservative.** The router reports the sum over submits of the bill the provider reported, or the
   list estimate where none was reported. A retried 429 therefore holds its estimate: the test asserts $1.89 for three refused
   Kling submits at $0.63 each. If OpenRouter does not bill a refused submit, the lead should decide how a known non-billing
   error reconciles to $0 (needs `paid.ts`, see below).
4. **Breaker, literal.** A trip is over 30% provider failures in the last 10 minutes, with no minimum sample size. So one
   failure in an empty window trips it and skips the provider for 10 minutes. A minimum sample needs a config value; not
   added here. After a skip the window starts when the skip ends, so the recovered provider starts clean (a bug found by
   test and fixed: in-flight retries that failed during the skip re-tripped it).
5. **Connection is checked first**, before capabilities and price. A target that is not connected is reported as NOT_CONNECTED
   whatever its capabilities are.
6. **Cache.** Per workspace (Bible 5.2), keyed by `assetCacheKey(spec, adapter.id)`. A hit writes no ledger row (nothing was
   paid) and is recorded through `recordHit`. The first write wins.
7. **Duplicate key.** A call already authorized under the same key is never sent again. The router moves on to other targets
   and returns `duplicate` if none is left.
8. **Stock is not a `ProviderAdapter`.** `ModelClass` has no `stock`, and a stock search returns many clips. `stock.ts`
   searches the `stock` route in order (Pexels, then Pixabay), free (price 0), with no ledger row. Lead: add `stock` to the
   contract, or keep this shape.
9. **Video submit goes through `gateway.call`, not `submitVideo`.** `submitVideo` sends the capability's first target model
   and has no `frame_images` field, so a fallback target would be sent with the wrong model. The adapter builds the same
   request with its own model and frames, through the gateway's authenticated call. Polling uses `pollVideo`.
10. **Image takes.** One image per call (`n: 1`). A take of 2 is the caller's second call with a new seed.
11. **Frames** must be public https URLs (OpenRouter fetches them). A Meridian storage URI cannot be sent.
12. **First-and-last-frame test.** A model whose listing lacks either frame is not submitted to (the listing answers the
    question; no spend). The live run submits to the models whose listing shows both frames. The pinned value is the first
    row that passes on a live submit.

## Needs a change outside this folder (reported, not made)

- **Gateway (eng-pipeline):** `submitVideo` should take an optional `model` and `frameImages`, so the adapter can use it.
  Until then the adapter's direct `gateway.call` is the workaround in decision 9.
- **Ledger (eng-pipeline / `paid.ts`):** `paidCall` marks any reported actual as a bill, but the router can report a sum that
  includes estimates for unbilled submits. A `LedgerEntry` flag for "partly estimated", or a way to reconcile a known
  non-billing error to $0, is needed.
- **Config (eng-contracts):** these values sit in the adapters and the router. Move them to `src/engine/config/`:
  `ROUTER_CONSTANTS` (poll interval 5 s, backoff 1 s base, 30 s cap, 7-day reliability window), the submit, image, speech and
  stock timeouts (60 s, 120 s, 120 s, 30 s), `OUTPUT_LIMITS` in `normalise.ts`, and the stock sizes in `pexels.ts` and
  `pixabay.ts` (1080 px minimum width and 1920 px height for Pixabay's search).
- **Artifact storage (W2):** `MediaStore` is an interface. The image and speech adapters need a real implementation (the
  artifact store over Meridian's object store). Video URLs are the provider's, and the cache stores whatever uri the router
  returns. Before a cached video URL is reused, the artifact store must copy it into storage and point the cache at the copy.
- **Contracts (eng-contracts):** `ModelClass` lacks `stock` (decision 8).
- **Video checks (W4 and W11):** the router validates the video URL only. Duration, codec and size must be probed by the
  media functions after storage and before the take gate. Bible section 19's rule to validate type, size, duration and codec
  before storing is met here for images (type, magic bytes, size) and speech (type, magic bytes, size; duration is probed
  later). For video it is met only for the URL.
- **Routes (lead):** after the live run, set `video.i2v_pinned` in `config/routes.ts` from `FrameTestRun.pinned`, and set the
  verified flags. `tts` and `image.edit` have null models, so they report not connected. `image.keyframe` is routed.
- **Persistence:** the router takes store interfaces. The memory stores are for tests. A live run needs the Postgres ledger,
  and Postgres or durable versions of the cache, stats, breaker and bucket stores. Without them the budget and cache are not
  shared across processes.

## Not verified (no live API; PROVIDER_APIS.md is the only source)

- The OpenRouter video policy-refusal body. PROVIDER_APIS.md has no refusal shape. `classify.ts` matches
  `moderat|content policy|policy|safety|unsafe` in a 400 body or a failed job's text. The fixtures for that are synthetic.
- The 400 "unsupported value" body. PROVIDER_APIS.md says the body lists the supported values, not its shape. The fixture is
  representative.
- Whether OpenRouter video takes an idempotency header. None is documented, so none is sent. A 5xx after the job was created
  may bill twice. The ledger holds one estimate per submit, so the books show the risk, but the provider does not dedupe.
- The `GET /videos/models` field types (durations as numbers, frame names as strings). An entry that does not match is
  rejected by id, not guessed.
- Pexels and Pixabay licence terms for commercial social use (E2.6, owner). Clips are `licence.status: "unverified"` with a
  null licence page. The licence page URL is not in PROVIDER_APIS.md, so it is not recorded. Nothing ships on a stock clip
  until the owner records the check in the rights rules.
- Speech and image-edit model ids. They are null in `config/routes.ts` (speech is set with the voice stage, W6; image.edit is
  set in E2 and is not built here, since it needs reference images). `image.keyframe` routes to `bytedance-seed/seedream-4.5`,
  the id PROVIDER_APIS.md gives as an example, not a verified one.
- Avatar IV via OpenRouter (Bible 20.3 item 3). There is no verified API, so the adapter reports NOT_CONNECTED.

## The owner's live run (exact steps)

Use the Postgres ledger and stores (see Persistence). Keep each run under a reservation that caps it. Record each result
below in the PR: ids, costs, and the activity-page figure beside each.

1. **Routes.** Run `verifyRoutes(gateway, ["video.cinematic", "video.budget", "image.keyframe"])` (gateway/openrouter.ts). Set
   `verified: true` in `config/routes.ts` for each id it lists.
2. **Listing.** `listVideoModels(gateway, orgId)`, then `videoProfilesFromListing(listing)`. Record `profiles` and `rejected`.
3. **First-and-last-frame run (Bible 20.3 item 2).** `runFirstLastFrameTest({ gateway, organizationId, workspaceId, ledger,
   reservationId, frames: { first, last }, durationSeconds: 5, at })` with two public https frame images and a reservation of
   $3 or less. Record `table`, the job ids, and the ledger estimates. Set `video.i2v_pinned` in `routes.ts` from `pinned` (or
   leave it null if `pinned` is null).
4. **One video.** `createAssetRouter(...).produce(...)` with `video.cinematic`, 5 s, 9:16, and no frames. Record `asset.uri`,
   `costUsd`, `costIsEstimate`, `submits`, `ledgerEntryId`, and the activity-page cost. Download the file through the gateway
   and probe it (media functions): confirm 1080 x 1920, duration within 0.1 s, H.264.
5. **One image.** `produce` with `image.keyframe` (`bytedance-seed/seedream-4.5`). Record the `uri`, `costUsd` (from
   `usage.cost`), the media type and the activity-page cost. Confirm the PNG opens.
6. **Speech.** Not run until the speech model id and a voice id are set (`tts`, Bible 20.2 and W6). Then `produce` with
   `tts` and the voice of a page. Record the generation id from `detailsFor`, and the estimated cost (speech reports none).
7. **Stock.** `searchStock` with Pexels and Pixabay keys and a query. Record the clip ids, `sourceUrl`, `author` and
   `downloadUrl`. Owner: read both licence terms for commercial short-form posts and record the decision (E2.6). Until then
   the clips stay `unverified`.
8. **Policy refusal.** Send one prompt the video model refuses. Record the exact 400 body or failed job, and confirm or change
   `POLICY_PATTERN` in `classify.ts`.
9. **Idempotency.** Owner decision whether to spend up to $1 to test whether an identical submit creates a second billed job.
   Record the result.
10. **Refused submits.** Check on the activity page whether a 429 submit is billed. Record it. This decides decision 3.
11. **Avatar.** Verify Avatar IV via OpenRouter (Bible 20.3 item 3) before any route is set. Until then it stays NOT_CONNECTED.

Bible section 19 E2 is not met by this work alone. The acceptance is one shot each for `ugc_presenter`, `product_hero`,
`stock_footage` and `coded_graphics` that passes the take gate, and a deliberately bad take that fails it. That needs the
planner, the take gate (W11) and the live run above.

## E3 additions (speech speed for the voice stage)

- `ProduceInput.speechSpeed` (default 1) reaches the adapter context (`providers/index.ts`) and the speech adapter
  (`providers/openrouterSpeech.ts`). A speed other than 1 is sent as `speed` in the request, and the adapter's id becomes
  `openrouter:<model>@speed=<n>`. That id is the cache identity and the breaker bucket, so a take at another pace is another
  call and never a cache hit for the default pace. The range is 0.5 to 2 (`SPEECH_SPEED_RANGE`, initial); anything else is
  refused before a request.
- The router and the adapters are otherwise unchanged. Tests: `providers/openrouterSpeech.test.ts` (the speed is sent, the
  identity carries it, the default sends nothing, out-of-range speeds are refused). The voice pipeline is tested in
  `src/engine/voice/voice.test.ts` against the real router.
- Live (owner): record one take at 1.0, 1.1 and 1.2 for the same text, and confirm that the speech route accepts `speed`
  (PROVIDER_APIS.md lists it; no live call has checked it).

## Speech cache key names the voice (variant work, this worktree)

- The router's cache and ledger key was `assetCacheKey(spec, providerId)`, which holds no voice. Two voices speaking the same text shared one
  cached take and one ledger key, so the second voice was served the first voice's audio (a hit at $0), or a duplicate. Fixed at the router:
  a speech spec (modelClass `tts`) is keyed by `routeCacheKey(spec, providerId, { voiceId })` (`cache.ts`), which adds the voice to the asset
  key. Every other spec keeps `assetCacheKey`, so no other key moves.
- Both router sites use it: the candidate's `cacheKey`, and the check a resumed job makes against its stored key (`checkJobFor`). The ledger
  key is that cache key, so two voices are two ledger rows.
- The adapter id is not changed. The circuit breaker and the provider statistics are per provider, and a per-voice adapter id would split
  them. The speed stays in the adapter id, as above.
- Tests: `router.test.ts`, "speech voices (Bible 10.4): the voice is part of the cache key" (2 tests). Two voices on the same text: each is a
  call, the first voice again is a hit at $0, and the ledger holds two rows with two keys. The key test checks that a non-speech spec's key is
  unchanged.
- The variant path no longer shifts the speech seed to keep variants apart: that was a workaround for this bug (variants/speak.ts).
- No speech data is live yet, so no key is migrated. Changing a speech key only moves speech calls.
